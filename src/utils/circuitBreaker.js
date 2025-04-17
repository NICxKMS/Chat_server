/**
 * Circuit Breaker Implementation
 * Protects against cascading failures when external services are unavailable
 */
import * as metrics from "./metrics.js";

// Circuit breaker states
const CircuitState = {
  CLOSED: "closed",      // Normal operation
  OPEN: "open",          // Circuit is open (failing)
  HALF_OPEN: "half-open" // Testing if service recovered
};

// Store active circuit breakers
const circuitBreakers = new Map();

/**
 * Circuit Breaker class
 * Implements the circuit breaker pattern for API calls
 */
class CircuitBreaker {
  /**
   * Create a new circuit breaker
   */
  constructor(name, action, options = {}) {
    this.name = name;
    this.action = action;
    this.fallback = options.fallback || null;
    this.failureThreshold = options.failureThreshold || 5;
    this.resetTimeout = options.resetTimeout || 30000;
    this.errorThreshold = options.errorThreshold || 50;
    this.onStateChange = options.onStateChange || (() => {});
    
    // Initialize state and counters
    this.state = CircuitState.CLOSED;
    this.failures = 0;
    this.successes = 0;
    this.fallbackCalls = 0;
    this.lastFailure = null;
    this.lastSuccess = null;
    this.nextAttempt = null;
    
    // Initialize metrics
    metrics.circuitBreakerGauge.set({ 
      name: this.name, 
      state: this.state 
    }, this.stateToValue());
    
    // Register this breaker
    circuitBreakers.set(name, this);
  }

  /**
   * Execute the action with circuit breaker protection
   */
  async fire(...args) {
    if (this.state === CircuitState.OPEN) {
      // Check if it's time to try again
      if (this.nextAttempt && new Date() > this.nextAttempt) {
        this.setState(CircuitState.HALF_OPEN);
      } else {
        return this.handleOpen(args);
      }
    }
    
    try {
      // Execute the action
      const result = await this.action(...args);
      
      // Record successful call
      this.recordSuccess();
      return result;
    } catch (error) {
      // Record failure
      this.recordFailure();
      
      // Handle fallback or rethrow
      if (this.fallback) {
        this.fallbackCalls++;
        return this.fallback(args[0], error);
      }
      
      throw error;
    }
  }

  /**
   * Record a successful call
   */
  recordSuccess() {
    this.successes++;
    this.lastSuccess = new Date();
    
    if (this.state === CircuitState.HALF_OPEN) {
      this.setState(CircuitState.CLOSED);
      this.failures = 0;
    }
    
    // Update metrics
    metrics.circuitBreakerGauge.set({ 
      name: this.name, 
      state: this.state 
    }, this.stateToValue());
  }

  /**
   * Record a failed call
   */
  recordFailure() {
    this.failures++;
    this.lastFailure = new Date();
    
    // Check if we should open the circuit
    if (this.state === CircuitState.CLOSED && this.failures >= this.failureThreshold) {
      this.setState(CircuitState.OPEN);
      this.nextAttempt = new Date(Date.now() + this.resetTimeout);
    } else if (this.state === CircuitState.HALF_OPEN) {
      this.setState(CircuitState.OPEN);
      this.nextAttempt = new Date(Date.now() + this.resetTimeout);
    }
    
    // Update metrics
    metrics.circuitBreakerGauge.set({ 
      name: this.name, 
      state: this.state 
    }, this.stateToValue());
  }

  /**
   * Handle open circuit
   */
  async handleOpen(args) {
    if (this.fallback) {
      this.fallbackCalls++;
      return this.fallback(args[0], new Error("Circuit is open"));
    }
    throw new Error(`Service ${this.name} is unavailable (circuit open)`);
  }

  /**
   * Set the circuit state
   */
  setState(newState) {
    this.state = newState;
    this.onStateChange(this.state, this.name);
  }

  /**
   * Convert state to numeric value for metrics
   */
  stateToValue() {
    switch (this.state) {
    case CircuitState.CLOSED: return 0;
    case CircuitState.HALF_OPEN: return 1;
    case CircuitState.OPEN: return 2;
    default: return -1;
    }
  }

  /**
   * Get current state information
   */
  getState() {
    return {
      name: this.name,
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      fallbackCalls: this.fallbackCalls,
      lastFailure: this.lastFailure,
      lastSuccess: this.lastSuccess
    };
  }
}

/**
 * Create a new circuit breaker
 */
function createBreaker(name, action, options = {}) {
  // Use existing breaker if available
  if (circuitBreakers.has(name)) {
    return circuitBreakers.get(name);
  }
  
  // Create new breaker
  return new CircuitBreaker(name, action, options);
}

/**
 * Get all circuit breaker states
 */
function getCircuitBreakerStates() {
  const states = {};
  circuitBreakers.forEach((breaker, name) => {
    states[name] = breaker.getState();
  });
  return states;
}

// Export circuit breaker functionality
export {
  CircuitState,
  CircuitBreaker,
  createBreaker,
  getCircuitBreakerStates
}; 