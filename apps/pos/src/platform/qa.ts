import { invoke, isTauri } from "@tauri-apps/api/core";
import type { PosOptions, PosCustomer } from "./pos-adapter";
export interface QaLine {
  productId: string;
  quantity: string;
  revision: string;
  free?: { name: string; unitPriceCents: string };
}
export interface QaSale {
  operationId: string;
  lines: QaLine[];
  tenderCents: string;
  cartId?: string | null;
  expectedCartRevision?: string | null;
  options?: PosOptions;
  acceptedQuoteHash?: string | null;
  fiscalType?: "B01" | "B02" | null;
}
export interface QaResult {
  operationId: string;
  hash: string;
  ticket: string;
  totalCents: string;
  itbisCents: string;
  changeCents: string;
  remoteStatus: "NOT_ENABLED";
}
export interface QaProduct {
  id: string;
  name: string;
  code: string;
  priceCents: string;
  stock: string;
  revision: string;
  availableSerials?: string[];
}
export interface QaCart {
  id: string;
  revision: string;
  label: string;
  lines: QaLine[];
}
export interface QaCatalogue {
  products: QaProduct[];
  confirmedSales: string;
  cashCents: string;
  pendingOperations: string;
  lastResult: QaResult | null;
  pendingAttempt: QaSale | null;
  carts: { active: QaCart | null; paused: QaCart[] };
  customers?: PosCustomer[];
}
export interface QaRead {
  status: "NOT_PROVISIONED" | "READY";
  catalogue: QaCatalogue | null;
}
type QaCommand =
  | "qa_history_read"
  | "qa_sale_abandon"
  | "qa_sale_ticket"
  | "qa_read"
  | "qa_create"
  | "qa_sell"
  | "qa_result"
  | "qa_quote"
  | "qa_product_save"
  | "qa_stock_adjust"
  | "qa_cart_save"
  | "qa_cart_action";
export async function qaInvoke<T>(
  command: QaCommand,
  payload: Record<string, unknown> = {},
): Promise<T> {
  if (!isTauri()) throw { code: "QA_NATIVE_REQUIRED" };
  return invoke<T>(command, {
    ...payload,
    ipcVersion: "ventard.qa.ipc.1",
    requestId: crypto.randomUUID(),
  });
}
export function qaError(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";
  return /^[A-Z_]{1,64}$/.test(code) ? code : "QA_NATIVE_UNAVAILABLE";
}
// Sólo presentación/parse de entrada, sin impuesto/precio/stock/negocio en JS.
export function showCents(value: string): string {
  const cents = BigInt(value);
  return `RD$ ${(cents / BigInt(100)).toLocaleString("es-DO")}.${String(cents % BigInt(100)).padStart(2, "0")}`;
}
export function inputCents(value: string): string {
  const m = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,2}))?$/.exec(value);
  if (!m) throw { code: "QA_AMOUNT_INVALID" };
  return (BigInt(m[1]) * BigInt(100) + BigInt((m[2] ?? "").padEnd(2, "0"))).toString();
}
