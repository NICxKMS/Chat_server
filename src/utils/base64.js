export function isBase64DataUrl(str) {
  return /^data:image\/(?:jpeg|png|gif|webp);base64,/.test(str);
}

export function parseBase64DataUrl(str) {
  const match = str.match(/^data:(image\/(?:jpeg|png|gif|webp));base64,(.*)$/);
  if (match) {
    return { mediaType: match[1], data: match[2] };
  }
  return null;
} 