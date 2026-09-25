import { RUNBOOK_PARAM_TYPES, runbookParamNameError, type RunbookParamDef, type RunbookParamType } from "@inv/shared";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** Form-friendly shape of a parameter definition (every field a string). */
export interface EditableParam {
  key: string;
  name: string;
  label: string;
  description: string;
  type: RunbookParamType;
  required: boolean;
  default: string;
  pattern: string;
  enumValues: string;
  maxLength: string;
}

let keySeq = 0;
const nextKey = () => `p${++keySeq}`;

export function toEditable(defs: RunbookParamDef[]): EditableParam[] {
  return defs.map((d) => ({
    key: nextKey(),
    name: d.name,
    label: d.label ?? "",
    description: d.description ?? "",
    type: d.type,
    required: d.required,
    default: d.default === undefined ? "" : String(d.default),
    pattern: d.pattern ?? "",
    enumValues: (d.enumValues ?? []).join(", "),
    maxLength: d.maxLength ? String(d.maxLength) : "",
  }));
}

/** Back to the API shape; empty optional fields are dropped. */
export function fromEditable(rows: EditableParam[]): RunbookParamDef[] {
  return rows.map((r) => {
    const def: RunbookParamDef = { name: r.name.trim(), type: r.type, required: r.required };
    if (r.label.trim()) def.label = r.label.trim();
    if (r.description.trim()) def.description = r.description.trim();
    if ((r.type === "string" || r.type === "secret") && r.pattern.trim()) def.pattern = r.pattern.trim();
    if (r.type === "enum") def.enumValues = r.enumValues.split(",").map((v) => v.trim()).filter(Boolean);
    if (r.maxLength.trim() && (r.type === "string" || r.type === "secret")) def.maxLength = Number(r.maxLength);
    if (r.default.trim() && r.type !== "secret") {
      def.default = r.type === "boolean" ? r.default.trim() === "true" : r.type === "number" ? Number(r.default) : r.default;
    }
    return def;
  });
}

/**
 * The parameters table in the runbook editor. Parameters reach the script as
 * environment variables exported at the top of the uploaded file — reference
 * them as "$NAME" in the script; they are never substituted into its text.
 */
export function ParamsBuilder({ rows, onChange, disabled }: { rows: EditableParam[]; onChange(rows: EditableParam[]): void; disabled?: boolean }) {
  const update = (key: string, patch: Partial<EditableParam>) => onChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const names = rows.map((r) => r.name.trim());

  return (
    <div className="space-y-2">
      {rows.length === 0 && <p className="text-xs text-muted-foreground">No parameters. The script runs as written.</p>}
      {rows.map((r) => {
        const nameErr = r.name.trim()
          ? runbookParamNameError(r.name.trim()) ?? (names.filter((n) => n === r.name.trim()).length > 1 ? "Duplicate name" : null)
          : "Name is required";
        return (
          <div key={r.key} className="rounded-lg border border-white/10 bg-white/5 p-3 space-y-2">
            <div className="grid gap-2 sm:grid-cols-[1.2fr_1.2fr_0.8fr_auto_auto] items-center">
              <Input
                className="h-8 font-mono text-xs"
                placeholder="NAME"
                value={r.name}
                disabled={disabled}
                onChange={(e) => update(r.key, { name: e.target.value.toUpperCase() })}
              />
              <Input className="h-8 text-xs" placeholder="Label" value={r.label} disabled={disabled} onChange={(e) => update(r.key, { label: e.target.value })} />
              <Select value={r.type} onValueChange={(v) => update(r.key, { type: v as RunbookParamType })} disabled={disabled}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RUNBOOK_PARAM_TYPES.map((t) => (
                    <SelectItem key={t} value={t} className="text-xs">
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <label className="flex items-center gap-1.5 text-xs">
                <Checkbox checked={r.required} disabled={disabled} onCheckedChange={(c) => update(r.key, { required: c === true })} />
                required
              </label>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                disabled={disabled}
                onClick={() => onChange(rows.filter((x) => x.key !== r.key))}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              {r.type !== "secret" && (
                <Input
                  className="h-8 text-xs font-mono"
                  placeholder={r.type === "boolean" ? "default: true / false" : "default"}
                  value={r.default}
                  disabled={disabled}
                  onChange={(e) => update(r.key, { default: e.target.value })}
                />
              )}
              {(r.type === "string" || r.type === "secret") && (
                <>
                  <Input
                    className="h-8 text-xs font-mono"
                    placeholder="pattern (full match), e.g. [0-9.]+"
                    value={r.pattern}
                    disabled={disabled}
                    onChange={(e) => update(r.key, { pattern: e.target.value })}
                  />
                  <Input
                    className="h-8 text-xs"
                    type="number"
                    min={1}
                    max={4096}
                    placeholder="max length (4096)"
                    value={r.maxLength}
                    disabled={disabled}
                    onChange={(e) => update(r.key, { maxLength: e.target.value })}
                  />
                </>
              )}
              {r.type === "enum" && (
                <Input
                  className="h-8 text-xs sm:col-span-2"
                  placeholder="values, comma separated"
                  value={r.enumValues}
                  disabled={disabled}
                  onChange={(e) => update(r.key, { enumValues: e.target.value })}
                />
              )}
            </div>
            <Input
              className="h-8 text-xs"
              placeholder="Description (optional)"
              value={r.description}
              disabled={disabled}
              onChange={(e) => update(r.key, { description: e.target.value })}
            />
            {nameErr && <p className="text-[11px] text-destructive">{nameErr}</p>}
            {r.type === "secret" && (
              <p className="text-[11px] text-muted-foreground">Secret values are masked as *** in stored output and never shown again.</p>
            )}
          </div>
        );
      })}
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={disabled}
        onClick={() =>
          onChange([
            ...rows,
            { key: nextKey(), name: "", label: "", description: "", type: "string", required: false, default: "", pattern: "", enumValues: "", maxLength: "" },
          ])
        }
      >
        <Plus className="h-4 w-4" /> Add parameter
      </Button>
    </div>
  );
}
