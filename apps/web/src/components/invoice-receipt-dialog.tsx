import { useState } from "react";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Printer,
  Copy,
  Check,
  CheckCircle2,
  Clock,
  XCircle,
  FileText,
  ShieldCheck,
  Building,
  CreditCard,
} from "lucide-react";
import { toast } from "sonner";
import type { OrderItem } from "@inv/shared";

interface InvoiceReceiptDialogProps {
  order: OrderItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function InvoiceReceiptDialog({
  order,
  open,
  onOpenChange,
}: InvoiceReceiptDialogProps) {
  const [copiedKey, setCopiedKey] = useState(false);

  if (!order) return null;

  const invoiceNum = order.invoiceNumber || `INV-${order.id.slice(0, 8).toUpperCase()}`;
  const orderDate = new Date(order.createdAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  const planLabel =
    order.planId === "enterprise"
      ? "RackMap Enterprise Edition"
      : order.planId === "pro"
      ? "RackMap Professional Edition"
      : "RackMap Community Edition";

  const nodeCountText =
    order.planId === "enterprise"
      ? "Unlimited Managed Nodes"
      : order.planId === "pro"
      ? "Up to 100 Managed Nodes"
      : "Up to 10 Managed Nodes";

  function handleCopyKey() {
    if (!order?.licenseKey) return;
    navigator.clipboard.writeText(order.licenseKey);
    setCopiedKey(true);
    toast.success("License key copied to clipboard!");
    setTimeout(() => setCopiedKey(false), 2000);
  }

  function handlePrint() {
    window.print();
  }

  const isPaid = order.status === "paid";
  const isPending = order.status === "pending";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl bg-slate-950 border-white/10 text-white p-0 overflow-hidden shadow-2xl">
        {/* Printable area */}
        <div id="printable-invoice" className="p-6 md:p-8 space-y-6">
          {/* Top Bar / Header */}
          <div className="flex items-start justify-between border-b border-white/10 pb-5">
            <div>
              <div className="flex items-center gap-2">
                <div className="h-8 w-8 rounded-lg bg-blue-600/20 border border-blue-500/30 flex items-center justify-center text-blue-400">
                  <FileText className="h-4 w-4" />
                </div>
                <div>
                  <h3 className="text-lg font-bold tracking-tight text-white">TAX INVOICE / RECEIPT</h3>
                  <p className="text-xs text-slate-400 font-mono">Invoice #{invoiceNum}</p>
                </div>
              </div>
            </div>

            <div className="text-right space-y-1">
              {isPaid && (
                <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30 text-xs px-2.5 py-0.5 uppercase tracking-wider font-semibold gap-1">
                  <CheckCircle2 className="h-3.5 w-3.5" /> PAID
                </Badge>
              )}
              {isPending && (
                <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30 text-xs px-2.5 py-0.5 uppercase tracking-wider font-semibold gap-1">
                  <Clock className="h-3.5 w-3.5" /> PENDING
                </Badge>
              )}
              {!isPaid && !isPending && (
                <Badge className="bg-rose-500/20 text-rose-400 border-rose-500/30 text-xs px-2.5 py-0.5 uppercase tracking-wider font-semibold gap-1">
                  <XCircle className="h-3.5 w-3.5" /> {order.status.toUpperCase()}
                </Badge>
              )}
              <div className="text-[11px] text-slate-400">Date: {orderDate}</div>
            </div>
          </div>

          {/* Parties Grid: Billed To & Billed By */}
          <div className="grid grid-cols-2 gap-6 text-xs">
            <div className="space-y-1 bg-slate-900/50 p-3.5 rounded-lg border border-white/5">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 block mb-1">
                Billed To
              </span>
              <p className="font-semibold text-white text-sm">{order.customerName}</p>
              <p className="text-slate-300">{order.customerEmail}</p>
              {order.company && (
                <p className="text-slate-400 flex items-center gap-1 mt-1">
                  <Building className="h-3 w-3" /> {order.company}
                </p>
              )}
            </div>

            <div className="space-y-1 bg-slate-900/50 p-3.5 rounded-lg border border-white/5">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 block mb-1">
                Issued By
              </span>
              <p className="font-semibold text-white text-sm">RackMap Licensing &amp; Cloud</p>
              <p className="text-slate-300">billing@rackmap.io</p>
              <p className="text-slate-400 font-mono text-[11px]">VAT / Tax ID: EU94810294</p>
            </div>
          </div>

          {/* Line Items Table */}
          <div className="border border-white/10 rounded-lg overflow-hidden">
            <table className="w-full text-xs text-left">
              <thead className="bg-slate-900 text-slate-400 uppercase text-[10px] border-b border-white/10">
                <tr>
                  <th className="py-2.5 px-4">Item &amp; Description</th>
                  <th className="py-2.5 px-4">Cycle</th>
                  <th className="py-2.5 px-4 text-right">Qty</th>
                  <th className="py-2.5 px-4 text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                <tr>
                  <td className="py-3 px-4">
                    <div className="font-semibold text-white">{planLabel}</div>
                    <div className="text-[11px] text-slate-400">{nodeCountText} • ATOP Performance Replay • Auto-Patching</div>
                  </td>
                  <td className="py-3 px-4 capitalize text-slate-300">
                    {order.billingCycle}
                  </td>
                  <td className="py-3 px-4 text-right text-slate-300">1</td>
                  <td className="py-3 px-4 text-right font-mono font-semibold text-white">
                    ${order.amount.toFixed(2)} {order.currency}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Invoice Summary & Totals */}
          <div className="flex justify-between items-start pt-2">
            <div className="text-xs space-y-1.5 max-w-xs">
              <span className="text-[11px] font-medium text-slate-400 flex items-center gap-1.5">
                <CreditCard className="h-3.5 w-3.5 text-blue-400" />
                Payment Method:{" "}
                <span className="text-white capitalize font-mono">{order.paymentGateway || "Credit Card / Licencia"}</span>
              </span>
              {order.paymentRef && (
                <div className="text-[10px] text-slate-500 font-mono truncate">
                  Ref: {order.paymentRef}
                </div>
              )}
            </div>

            <div className="w-48 space-y-1 text-xs text-right">
              <div className="flex justify-between text-slate-400">
                <span>Subtotal:</span>
                <span className="font-mono">${order.amount.toFixed(2)}</span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>Tax (0%):</span>
                <span className="font-mono">$0.00</span>
              </div>
              <div className="flex justify-between border-t border-white/10 pt-2 font-bold text-sm text-white">
                <span>Total Paid:</span>
                <span className="font-mono text-emerald-400">
                  ${order.amount.toFixed(2)} {order.currency}
                </span>
              </div>
            </div>
          </div>

          {/* License Key Fulfillment Box */}
          {order.licenseKey && (
            <div className="bg-slate-900/80 rounded-xl border border-white/10 p-4 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
                  <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
                  Assigned Licencia License Key
                </span>
                <Badge variant="outline" className="text-[10px] border-emerald-500/30 text-emerald-400 bg-emerald-500/10">
                  {order.planId.toUpperCase()}
                </Badge>
              </div>

              <div className="flex items-center gap-2">
                <div className="flex-1 font-mono text-xs text-emerald-300 bg-slate-950 p-2.5 rounded-lg border border-white/5 truncate select-all">
                  {order.licenseKey}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleCopyKey}
                  className="h-9 border-white/10 text-slate-300 hover:text-white shrink-0 gap-1 text-xs"
                >
                  {copiedKey ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                  {copiedKey ? "Copied" : "Copy"}
                </Button>
              </div>
            </div>
          )}

          {/* Footer Note */}
          <div className="border-t border-white/5 pt-4 text-center text-[11px] text-slate-500">
            This is an official automated receipt issued for RackMap Infrastructure Services. All licenses are governed by the Licencia Software Agreement.
          </div>
        </div>

        {/* Modal Actions */}
        <div className="bg-slate-900 px-6 py-4 border-t border-white/10 flex items-center justify-between">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            className="border-white/10 text-xs text-slate-300 hover:text-white"
          >
            Close
          </Button>

          <Button
            size="sm"
            onClick={handlePrint}
            className="bg-blue-600 hover:bg-blue-500 text-white font-medium text-xs gap-1.5 shadow-sm"
          >
            <Printer className="h-3.5 w-3.5" />
            Print / Save PDF
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
