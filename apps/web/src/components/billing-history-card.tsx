import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { checkoutKeys, fetchUserOrders } from "@/lib/queries";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  FileText,
  Search,
  CheckCircle2,
  Clock,
  XCircle,
  Sparkles,
  Printer,
  Copy,
  Check,
  CreditCard,
  Receipt,
  ShieldCheck,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { InvoiceReceiptDialog } from "./invoice-receipt-dialog";
import type { OrderItem } from "@inv/shared";

interface BillingHistoryCardProps {
  onUpgradeClick?: () => void;
}

export function BillingHistoryCard({ onUpgradeClick }: BillingHistoryCardProps) {
  const { data, isLoading } = useQuery({
    queryKey: checkoutKeys.orders(),
    queryFn: fetchUserOrders,
  });

  const [search, setSearch] = useState("");
  const [selectedOrder, setSelectedOrder] = useState<OrderItem | null>(null);
  const [copiedKeyId, setCopiedKeyId] = useState<string | null>(null);

  const orders = data?.orders ?? [];

  const filteredOrders = orders.filter((o) => {
    const term = search.toLowerCase().trim();
    if (!term) return true;
    return (
      (o.invoiceNumber && o.invoiceNumber.toLowerCase().includes(term)) ||
      o.id.toLowerCase().includes(term) ||
      o.planId.toLowerCase().includes(term) ||
      (o.company && o.company.toLowerCase().includes(term)) ||
      o.customerName.toLowerCase().includes(term) ||
      (o.licenseKey && o.licenseKey.toLowerCase().includes(term))
    );
  });

  const totalSpent = orders
    .filter((o) => o.status === "paid")
    .reduce((acc, o) => acc + (o.amount || 0), 0);

  function handleCopyKey(orderId: string, key: string, e: React.MouseEvent) {
    e.stopPropagation();
    navigator.clipboard.writeText(key);
    setCopiedKeyId(orderId);
    toast.success("License key copied!");
    setTimeout(() => setCopiedKeyId(null), 2000);
  }

  return (
    <div className="space-y-4">
      {/* Top Metric Bar */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
        <div className="rounded-xl border bg-card/60 p-4 space-y-1">
          <div className="flex items-center justify-between text-muted-foreground">
            <span>Total Invoices</span>
            <Receipt className="h-4 w-4 text-blue-500" />
          </div>
          <div className="text-xl font-bold tracking-tight text-foreground">
            {isLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : orders.length}
          </div>
          <p className="text-[11px] text-muted-foreground">Historical order fulfillment logs</p>
        </div>

        <div className="rounded-xl border bg-card/60 p-4 space-y-1">
          <div className="flex items-center justify-between text-muted-foreground">
            <span>Total Invested</span>
            <CreditCard className="h-4 w-4 text-emerald-500" />
          </div>
          <div className="text-xl font-bold tracking-tight text-emerald-500 font-mono">
            {isLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : `$${totalSpent.toFixed(2)} USD`}
          </div>
          <p className="text-[11px] text-muted-foreground">Paid software licensing fees</p>
        </div>

        <div className="rounded-xl border bg-card/60 p-4 space-y-1">
          <div className="flex items-center justify-between text-muted-foreground">
            <span>Billing Status</span>
            <ShieldCheck className="h-4 w-4 text-purple-500" />
          </div>
          <div className="text-xl font-bold tracking-tight text-foreground">
            {orders.some((o) => o.status === "paid") ? "Active Client" : "Standard Tier"}
          </div>
          <p className="text-[11px] text-muted-foreground">Licencia direct activation gateway</p>
        </div>
      </div>

      {/* Main Table Card */}
      <div className="rounded-xl border bg-card text-card-foreground shadow-sm overflow-hidden">
        {/* Header & Search */}
        <div className="p-4 sm:p-5 border-b flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-muted/10">
          <div>
            <h3 className="text-sm font-semibold flex items-center gap-2 text-foreground">
              <FileText className="h-4 w-4 text-blue-500" />
              Billing &amp; Invoice History
            </h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Review transaction receipts, past subscription payments, and generated Licencia license keys
            </p>
          </div>

          <div className="flex items-center gap-2">
            <div className="relative w-full sm:w-56">
              <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search invoice or key…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-8 text-xs pl-8 bg-background border-border/80"
              />
            </div>

            {onUpgradeClick && (
              <Button
                size="sm"
                onClick={onUpgradeClick}
                className="h-8 text-xs bg-blue-600 hover:bg-blue-500 text-white font-medium gap-1.5 shrink-0 shadow-sm"
              >
                <Sparkles className="h-3.5 w-3.5" />
                New Checkout
              </Button>
            )}
          </div>
        </div>

        {/* Content State */}
        {isLoading ? (
          <div className="p-12 text-center space-y-3">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground mx-auto" />
            <p className="text-xs text-muted-foreground">Loading billing history…</p>
          </div>
        ) : filteredOrders.length === 0 ? (
          <div className="p-12 text-center space-y-4">
            <div className="h-12 w-12 rounded-2xl bg-muted/60 border flex items-center justify-center mx-auto text-muted-foreground">
              <Receipt className="h-6 w-6 opacity-60" />
            </div>
            <div className="max-w-md mx-auto space-y-1">
              <h4 className="text-sm font-semibold text-foreground">No Billing History Found</h4>
              <p className="text-xs text-muted-foreground leading-relaxed">
                {search
                  ? `No orders matching "${search}". Try clearing your search query.`
                  : "You are currently running the Free Community Edition. Upgrade your plan to expand managed node capacity, enable ATOP performance spike replay, and unlock automated OS updates."}
              </p>
            </div>
            {onUpgradeClick && !search && (
              <Button
                size="sm"
                onClick={onUpgradeClick}
                className="bg-blue-600 hover:bg-blue-500 text-white text-xs gap-1.5"
              >
                <Sparkles className="h-3.5 w-3.5" />
                Explore Plans &amp; Upgrade
              </Button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead className="bg-muted/40 text-muted-foreground border-b text-[11px] uppercase tracking-wider font-semibold">
                <tr>
                  <th className="py-3 px-4">Invoice #</th>
                  <th className="py-3 px-4">Plan &amp; Cycle</th>
                  <th className="py-3 px-4">Date</th>
                  <th className="py-3 px-4">Amount</th>
                  <th className="py-3 px-4">Method</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">License Key</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {filteredOrders.map((order) => {
                  const invoiceNum = order.invoiceNumber || `INV-${order.id.slice(0, 8).toUpperCase()}`;
                  const orderDate = new Date(order.createdAt).toLocaleDateString("en-US", {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                  });
                  const isPaid = order.status === "paid";
                  const isPending = order.status === "pending";

                  return (
                    <tr
                      key={order.id}
                      className="hover:bg-muted/30 transition-colors group cursor-pointer"
                      onClick={() => setSelectedOrder(order)}
                    >
                      {/* Invoice # */}
                      <td className="py-3.5 px-4 font-mono font-medium text-foreground">
                        <div className="flex items-center gap-1.5">
                          <FileText className="h-3.5 w-3.5 text-blue-500 shrink-0" />
                          <span>{invoiceNum}</span>
                        </div>
                      </td>

                      {/* Plan & Cycle */}
                      <td className="py-3.5 px-4">
                        <div className="flex items-center gap-1.5">
                          <Badge
                            className={
                              order.planId === "enterprise"
                                ? "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30 uppercase text-[10px] px-1.5"
                                : order.planId === "pro"
                                ? "bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30 uppercase text-[10px] px-1.5"
                                : "bg-muted text-muted-foreground border-border uppercase text-[10px] px-1.5"
                            }
                          >
                            {order.planId}
                          </Badge>
                          <span className="text-muted-foreground capitalize text-[11px]">
                            ({order.billingCycle})
                          </span>
                        </div>
                      </td>

                      {/* Date */}
                      <td className="py-3.5 px-4 text-muted-foreground whitespace-nowrap">
                        {orderDate}
                      </td>

                      {/* Amount */}
                      <td className="py-3.5 px-4 font-mono font-semibold text-foreground whitespace-nowrap">
                        ${order.amount.toFixed(2)} {order.currency}
                      </td>

                      {/* Method */}
                      <td className="py-3.5 px-4 capitalize text-muted-foreground whitespace-nowrap">
                        {order.paymentGateway || "Card"}
                      </td>

                      {/* Status */}
                      <td className="py-3.5 px-4 whitespace-nowrap">
                        {isPaid && (
                          <Badge className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30 text-[10px] px-2 py-0.5 gap-1">
                            <CheckCircle2 className="h-3 w-3" /> Paid
                          </Badge>
                        )}
                        {isPending && (
                          <Badge className="bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30 text-[10px] px-2 py-0.5 gap-1">
                            <Clock className="h-3 w-3" /> Pending
                          </Badge>
                        )}
                        {!isPaid && !isPending && (
                          <Badge className="bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30 text-[10px] px-2 py-0.5 gap-1">
                            <XCircle className="h-3 w-3" /> {order.status}
                          </Badge>
                        )}
                      </td>

                      {/* License Key */}
                      <td className="py-3.5 px-4 max-w-[160px]">
                        {order.licenseKey ? (
                          <div className="flex items-center gap-1.5">
                            <span className="font-mono text-[11px] text-muted-foreground truncate select-all">
                              {order.licenseKey.slice(0, 11)}…
                            </span>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
                              onClick={(e) => handleCopyKey(order.id, order.licenseKey!, e)}
                              title="Copy License Key"
                            >
                              {copiedKeyId === order.id ? (
                                <Check className="h-3 w-3 text-emerald-500" />
                              ) : (
                                <Copy className="h-3 w-3" />
                              )}
                            </Button>
                          </div>
                        ) : (
                          <span className="text-muted-foreground text-[11px] italic">—</span>
                        )}
                      </td>

                      {/* Actions */}
                      <td className="py-3.5 px-4 text-right whitespace-nowrap">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs border-border/80 gap-1.5 hover:bg-muted"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedOrder(order);
                          }}
                        >
                          <Printer className="h-3 w-3" />
                          View Receipt
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Printable Invoice Dialog */}
      <InvoiceReceiptDialog
        order={selectedOrder}
        open={!!selectedOrder}
        onOpenChange={(open) => !open && setSelectedOrder(null)}
      />
    </div>
  );
}
