// Triggering a browser download from a Blob has two easy-to-miss requirements,
// and getting either wrong silently produces "nothing happens" rather than an
// error:
//
//   1. The anchor must be in the document. Firefox (and some other browsers)
//      ignore .click() on a detached element.
//   2. The object URL must stay alive until the browser has actually started
//      reading it. Revoking synchronously right after .click() races the
//      download and usually cancels it.
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  // Give the browser a beat to pick up the download before releasing the URL.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
