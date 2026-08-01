export const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;
// Context documents are ordinary office files — a Word doc with a few figures
// in it routinely passes 3MB, so they get a larger ceiling than plate exports.
// Keep REQUEST_BODY_LIMIT in app.ts comfortably above this ×4/3 (base64 growth).
export const MAX_DOCUMENT_UPLOAD_BYTES = 10 * 1024 * 1024;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export class UploadInputError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
  }
}

function isZipContainer(buffer: Buffer): boolean {
  return (
    buffer.byteLength >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    ((buffer[2] === 0x03 && buffer[3] === 0x04) ||
      (buffer[2] === 0x05 && buffer[3] === 0x06) ||
      (buffer[2] === 0x07 && buffer[3] === 0x08))
  );
}

function isPdfContainer(buffer: Buffer): boolean {
  return buffer.byteLength >= 5 && buffer.subarray(0, 5).toString("latin1") === "%PDF-";
}

export function decodeUpload(
  b64: string,
  filename: string,
  opts: { allowedExt?: string[]; typeErrorMessage?: string; maxBytes?: number } = {},
): Buffer {
  const maxBytes = opts.maxBytes ?? MAX_UPLOAD_BYTES;
  const maxBase64Chars = Math.ceil((maxBytes * 4) / 3) + 16;
  const tooLarge = () =>
    new UploadInputError(`File too large. Maximum upload size is ${Math.round(maxBytes / 1024 / 1024)}MB.`, 413);

  if (!filename.trim() || filename.length > 255 || /[\0\r\n/\\]/.test(filename)) {
    throw new UploadInputError("Invalid file name.");
  }
  if (b64.length > maxBase64Chars) throw tooLarge();
  if (!b64.length || b64.length % 4 !== 0 || !BASE64_RE.test(b64)) {
    throw new UploadInputError("Invalid file encoding.");
  }
  const buffer = Buffer.from(b64, "base64");
  if (!buffer.byteLength) {
    throw new UploadInputError("The uploaded file is empty.");
  }
  if (buffer.byteLength > maxBytes) throw tooLarge();
  const allowedExt = opts.allowedExt ?? ["csv", "tsv", "txt", "xlsx"];
  const ext = filename.split(".").pop()?.toLowerCase();
  if (!ext || !allowedExt.includes(ext)) {
    // Legacy binary Office formats are a common and confusing failure — name
    // the fix rather than saying "unsupported".
    if (ext === "doc") {
      throw new UploadInputError("Old Word .doc files aren't supported. Open it in Word and use File → Save As → .docx, then upload that.");
    }
    if (ext === "xls") {
      throw new UploadInputError("Old Excel .xls files aren't supported. Re-save it as .xlsx and upload that.");
    }
    if (ext === "pages" || ext === "odt" || ext === "rtf") {
      throw new UploadInputError(`.${ext} isn't supported. Export it as .docx or .pdf and upload that.`);
    }
    throw new UploadInputError(opts.typeErrorMessage ?? "Unsupported file type. Upload CSV, TSV, TXT, or XLSX files.");
  }
  if ((ext === "xlsx" || ext === "docx" || ext === "zip") && !isZipContainer(buffer)) {
    throw new UploadInputError(`The .${ext} file signature is invalid.`);
  }
  if (ext === "pdf" && !isPdfContainer(buffer)) {
    throw new UploadInputError("The .pdf file signature is invalid.");
  }
  if (["csv", "tsv", "txt"].includes(ext) && buffer.includes(0)) {
    throw new UploadInputError("The text upload contains binary data.");
  }
  return buffer;
}
