export const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;
export const MAX_UPLOAD_BASE64_CHARS = Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 16;
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
  opts: { allowedExt?: string[]; typeErrorMessage?: string } = {},
): Buffer {
  if (!filename.trim() || filename.length > 255 || /[\0\r\n/\\]/.test(filename)) {
    throw new UploadInputError("Invalid file name.");
  }
  if (b64.length > MAX_UPLOAD_BASE64_CHARS) {
    throw new UploadInputError(`File too large. Maximum upload size is ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB.`, 413);
  }
  if (!b64.length || b64.length % 4 !== 0 || !BASE64_RE.test(b64)) {
    throw new UploadInputError("Invalid file encoding.");
  }
  const buffer = Buffer.from(b64, "base64");
  if (!buffer.byteLength) {
    throw new UploadInputError("The uploaded file is empty.");
  }
  if (buffer.byteLength > MAX_UPLOAD_BYTES) {
    throw new UploadInputError(`File too large. Maximum upload size is ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB.`, 413);
  }
  const allowedExt = opts.allowedExt ?? ["csv", "tsv", "txt", "xlsx"];
  const ext = filename.split(".").pop()?.toLowerCase();
  if (!ext || !allowedExt.includes(ext)) {
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
