// pdf-parse's package-level types only cover the root module, whose own
// index.js has a debug side effect that crashes under esbuild bundling (see
// routes/projects.ts). We import its internal implementation module instead,
// which has no bundled type declarations of its own.
declare module "pdf-parse/lib/pdf-parse.js" {
  function pdfParse(dataBuffer: Buffer, options?: unknown): Promise<{ text: string }>;
  export default pdfParse;
}
