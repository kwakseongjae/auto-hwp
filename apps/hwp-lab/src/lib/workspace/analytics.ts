import { event } from "../gtag";

export type DocumentSource = "upload" | "sample" | "drop" | "recovery" | "url" | "unknown";
export type FileType = "hwp" | "hwpx" | "unknown";
export type OpenResult = "success" | "unsupported" | "empty" | "too_large" | "cancelled" | "failed";
export type ExportFormat = "html" | "pdf" | "hwpx" | "unknown";

export function fileType(name: string): FileType {
  if (/\.hwpx$/i.test(name)) return "hwpx";
  if (/\.hwp$/i.test(name)) return "hwp";
  return "unknown";
}

export function pageCountBucket(pages: number | undefined): string {
  if (!pages || pages < 1) return "unknown";
  if (pages === 1) return "1";
  if (pages <= 5) return "2-5";
  if (pages <= 10) return "6-10";
  if (pages <= 25) return "11-25";
  if (pages <= 50) return "26-50";
  return "51+";
}

export function trackUploadStart(args: { fileType: FileType; source: "picker" | "drop" }): void {
  event("ws_upload_start", { file_type: args.fileType, source: args.source });
}

export function trackDocumentOpen(args: {
  fileType: FileType;
  source: DocumentSource;
  result: OpenResult;
  pages?: number;
}): void {
  event("ws_document_open", {
    file_type: args.fileType,
    source: args.source,
    result: args.result,
    page_count_bucket: pageCountBucket(args.pages),
  });
}

export function trackAiRequest(args: { transport: "demo" | "byok" }): void {
  event("ws_ai_request", { transport: args.transport });
}

export function trackExport(args: { format: ExportFormat; result: "success" }): void {
  event("ws_export", args);
}

export function trackLayoutReportOpen(): void {
  event("ws_layout_report_open");
}

export function trackAgentPromptCopy(args: { result: "success" | "failed" }): void {
  event("docs_agent_prompt_copy", args);
}
