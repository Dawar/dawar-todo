"use client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { useRef, useEffect, useId, useState } from "react";
import { CreateTaskRequest } from "./task-request-ui";
import type { BotRequest } from "../../lib/bots-types";

type JsonSchema = {
  type?: string | string[];
  title?: string;
  description?: string;
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  default?: unknown;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
};
function FormField({
  name,
  schema,
  required,
  disabled,
  value,
  onChange,
}: {
  name: string;
  schema: JsonSchema;
  required: boolean;
  disabled: boolean;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  if (schema.enum)
    return (
      <label>
        {schema.title ?? name}
        <NativeSelect disabled={disabled}
          required={required}
          value={String(value ?? "")}
          onChange={(e) =>
            onChange(schema.enum!.find((x) => String(x) === e.target.value))
          }
        >
          <option value="">Choose…</option>
          {schema.enum.map((v, i) => (
            <option key={i} value={String(v)}>
              {String(v)}
            </option>
          ))}
        </NativeSelect>
      </label>
    );
  if (schema.type === "boolean")
    return (
      <label className="bots-checkbox">
        <input disabled={disabled}
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
        />
        {schema.title ?? name}
      </label>
    );
  if (schema.type === "object" && schema.properties)
    return (
      <fieldset>
        <legend>{schema.title ?? name}</legend>
        {Object.entries(schema.properties).map(([key, child]) => (
          <FormField
            key={key}
            name={key}
            schema={child}
            disabled={disabled}
            required={schema.required?.includes(key) ?? false}
            value={(value as Record<string, unknown>)?.[key]}
            onChange={(v) =>
              onChange({
                ...((value as Record<string, unknown>) ?? {}),
                [key]: v,
              })
            }
          />
        ))}
      </fieldset>
    );
  if (schema.type === "array" || schema.type === "object")
    return (
      <label>
        {schema.title ?? name}
        <Textarea disabled={disabled} className="min-h-32 font-mono"
          required={required}
          placeholder="JSON value"
          defaultValue={value === undefined ? "" : JSON.stringify(value)}
          onChange={(e) => {
            try {
              onChange(JSON.parse(e.target.value));
              e.target.setCustomValidity("");
            } catch {
              e.target.setCustomValidity("Enter valid JSON.");
            }
          }}
        />
      </label>
    );
  const numeric = schema.type === "integer" || schema.type === "number";
  return (
    <label>
      {schema.title ?? name}
      {schema.description && <small>{schema.description}</small>}
      <Input disabled={disabled}
        required={required}
        type={numeric ? "number" : "text"}
        step={schema.type === "integer" ? 1 : "any"}
        value={String(value ?? "")}
        min={schema.minimum}
        max={schema.maximum}
        minLength={schema.minLength}
        maxLength={schema.maxLength}
        onChange={(e) =>
          onChange(numeric ? Number(e.target.value) : e.target.value)
        }
      />
    </label>
  );
}
function decisionLabel(decision: unknown) {
  if (decision === "accept" || decision === "approved") return "Allow once";
  if (decision === "acceptForSession" || decision === "approved_for_session")
    return "Allow for session";
  if (decision === "decline") return "Decline";
  if (decision === "cancel" || decision === "abort") return "Cancel";
  return "Allow and save rule";
}
const runForms = new Map<string, { answers: Record<string, string>; form: Record<string, unknown>; raw: boolean; rawText: string | null }>();
export function RequestCard({
  pending,
  respond,
  disabled,
  memoryKey,
}: {
  pending: BotRequest;
  respond: (result: unknown) => Promise<void>;
  disabled: boolean;
  memoryKey?: string;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>(() => memoryKey ? runForms.get(memoryKey)?.answers ?? {} : {}),
    [form, setForm] = useState<Record<string, unknown>>(() => {
      if (memoryKey && runForms.has(memoryKey)) return runForms.get(memoryKey)!.form;
      const p = pending.request.params;
      const schema = (
        "requestedSchema" in p ? p.requestedSchema : {}
      ) as JsonSchema;
      return Object.fromEntries(
        Object.entries(schema.properties ?? {})
          .filter(([, v]) => v.default !== undefined)
          .map(([k, v]) => [k, v.default]),
      );
    }),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [accepted, setAccepted] = useState(false),
    [raw, setRaw] = useState(() => memoryKey ? runForms.get(memoryKey)?.raw ?? false : false);
  const [rawText, setRawText] = useState<string | null>(() => memoryKey ? runForms.get(memoryKey)?.rawText ?? null : null);
  useEffect(() => { if (memoryKey) runForms.set(memoryKey, { answers, form, raw, rawText }); }, [memoryKey, answers, form, raw, rawText]);
  const errorId = useId();
  const submitting = useRef(false);
  const request = pending.request;
  async function submit(result: unknown) {
    // A rapid second tap can arrive before React renders the disabled button.
    if (submitting.current || disabled) return;
    submitting.current = true;
    setBusy(true);
    setAccepted(false);
    setError("");
    try {
      await respond(result);
      // Keep the card locked until the resolved request disappears from the
      // snapshot. A slow event should not invite a second answer.
      setAccepted(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Response failed.");
      setBusy(false);
      submitting.current = false;
    }
  }
  const locked = disabled || busy;
  let content;
  if (request.method === "item/tool/requestUserInput")
    content = (
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (locked) return;
          const missing = request.params.questions.find(
            (q) => !answers[q.id]?.trim(),
          );
          if (missing) {
            setError(`Select an option or type an answer for ${missing.header}.`);
            return;
          }
          void submit({
            answers: Object.fromEntries(
              request.params.questions.map((q) => [
                q.id,
                {
                  answers: [
                    q.options?.some((option) => option.label === answers[q.id])
                      ? answers[q.id]
                      : answers[q.id].trim(),
                  ],
                },
              ]),
            ),
          });
        }}
      >
        {request.params.questions.map((q) => (
          <fieldset key={q.id} disabled={locked}>
            <legend>{q.question}</legend>
            {q.options?.map((option) => (
              <label key={option.label} className="bots-option">
                <input
                  type="radio"
                  name={pending.key + q.id}
                  checked={answers[q.id] === option.label}
                  onChange={() => {
                    setAnswers((current) => ({
                      ...current,
                      [q.id]: option.label,
                    }));
                    setError("");
                  }}
                />
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.description}</small>
                </span>
              </label>
            ))}
            <Input
              type={q.isSecret ? "password" : "text"}
              aria-label={`Answer: ${q.header}`}
              placeholder={
                q.options?.length ? "Or type your answer…" : "Your answer…"
              }
              value={
                q.options?.some((o) => o.label === answers[q.id])
                  ? ""
                  : (answers[q.id] ?? "")
              }
              onChange={(e) => {
                const value = e.target.value;
                setAnswers((current) => ({ ...current, [q.id]: value }));
                setError("");
              }}
            />
          </fieldset>
        ))}

        <Button variant="default" disabled={locked}>
          {accepted ? "Answers sent" : busy ? "Sending answers…" : "Send answers"}
        </Button>
        {!request.params.questions.some(q => q.isSecret) && <CreateTaskRequest params={{threadId: request.params.threadId, questionKey: pending.key}}/>}
      </form>
    );
  else if (request.method === "mcpServer/elicitation/request") {
    const p = request.params;
    if (p.mode === "url")
      content = (
        <>
          <p>{p.message}</p>
          <Button asChild><a
            target="_blank"
            rel="noreferrer"
            href={/^https?:\/\//.test(p.url) ? p.url : undefined}
          >
            Open authorization
          </a></Button>
          <div className="bots-request-actions">
            <Button variant="outline"
              disabled={locked}
              onClick={() => void submit({ action: "accept", content: null })}
            >
              I’ve completed this
            </Button>
            <Button variant="outline"
              disabled={locked}
              onClick={() => void submit({ action: "cancel", content: null })}
            >
              Cancel
            </Button>
          </div>
        </>
      );
    else if (p.mode === "openai/userVerification")
      content = (
        <>
          <p>{p.title}</p>
          <p>{p.description}</p>
          <p>Device verification is unavailable here.</p>
          <Button variant="outline"
            disabled={locked}
            onClick={() => void submit({ action: "cancel", content: null })}
          >
            Cancel request
          </Button>
        </>
      );
    else {
      const schema = p.requestedSchema as JsonSchema;
      content = (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit({ action: "accept", content: form });
          }}
        >
          <p>{p.message}</p>
          <label className="bots-checkbox">
            <input
              disabled={locked}
              type="checkbox"
              checked={raw}
              onChange={(e) => { setRaw(e.target.checked); setRawText(JSON.stringify(form, null, 2)); }}
            />
            Edit response as JSON
          </label>
          {!raw && schema.properties ? (
            Object.entries(schema.properties).map(([key, field]) => (
              <FormField
                key={key}
                name={key}
                schema={field}
                disabled={locked}
                required={schema.required?.includes(key) ?? false}
                value={form[key] ?? field.default}
                onChange={(value) => setForm({ ...form, [key]: value })}
              />
            ))
          ) : (
            <label>
              Response (JSON)
              <Textarea disabled={locked} className="min-h-32 font-mono"
                required
                value={rawText ?? JSON.stringify(form, null, 2)}
                onChange={(e) => {
                  setRawText(e.target.value);
                  try {
                    setForm(JSON.parse(e.target.value));
                    e.target.setCustomValidity("");
                  } catch {
                    e.target.setCustomValidity("Enter valid JSON.");
                  }
                }}
              />
            </label>
          )}
          <div className="bots-request-actions">
            <Button variant="default" disabled={locked}>
              Submit
            </Button>
            <Button variant="outline"
              type="button"
              disabled={locked}
              onClick={() => void submit({ action: "decline", content: null })}
            >
              Decline
            </Button>
            <Button variant="outline"
              type="button"
              disabled={locked}
              onClick={() => void submit({ action: "cancel", content: null })}
            >
              Cancel
            </Button>
          </div>
        </form>
      );
    }
  } else if (request.method === "item/permissions/requestApproval")
    content = (
      <>
        <p>
          {request.params.reason ??
            "This bot is requesting additional permissions."}
        </p>
        <pre>{JSON.stringify(request.params.permissions, null, 2)}</pre>
        <div className="bots-request-actions">
          <Button variant="default"
            disabled={locked}
            onClick={() =>
              void submit({
                permissions: request.params.permissions,
                scope: "turn",
              })
            }
          >
            Allow this turn
          </Button>
          <Button variant="outline"
            disabled={locked}
            onClick={() =>
              void submit({
                permissions: request.params.permissions,
                scope: "session",
              })
            }
          >
            Allow for session
          </Button>
          <Button variant="outline"
            disabled={locked}
            onClick={() => void submit({ permissions: {}, scope: "turn" })}
          >
            Decline
          </Button>
        </div>
      </>
    );
  else if (
    request.method === "item/commandExecution/requestApproval" ||
    request.method === "item/fileChange/requestApproval" ||
    request.method === "applyPatchApproval" ||
    request.method === "execCommandApproval"
  ) {
    const p = request.params;
    const legacy =
      request.method === "applyPatchApproval" ||
      request.method === "execCommandApproval";
    const decisions =
      "availableDecisions" in p && p.availableDecisions?.length
        ? p.availableDecisions
        : legacy
          ? ["approved", "approved_for_session", "abort"]
          : ["accept", "acceptForSession", "decline", "cancel"];
    content = (
      <>
        <p>{p.reason ?? "This action needs your approval."}</p>
        {"command" in p && (
          <pre>
            {typeof p.command === "string"
              ? p.command
              : JSON.stringify(p.command, null, 2)}
          </pre>
        )}
        <details>
          <summary>Action details</summary>
          <pre>{JSON.stringify(p, null, 2)}</pre>
        </details>
        <div className="bots-request-actions">
          {decisions.map((decision, i) => (
            <Button variant={i === 0 ? "default" : "outline"}
              key={i}
              disabled={locked}
              onClick={() => void submit({ decision })}
            >
              {decisionLabel(decision)}
            </Button>
          ))}
        </div>
      </>
    );
  } else content = <p>This request is handled by the bot runtime.</p>;
  return (
    <section className="bots-request" aria-label="Bot needs your input" aria-busy={busy && !accepted} aria-describedby={error ? errorId : undefined}>
      <div className="bots-request-title">Your input is needed</div>
      {content}
      {error && (
        <p id={errorId} role="alert" className="bots-error">
          {error}
        </p>
      )}
      {busy && (
        <p role="status" className={request.method === "item/tool/requestUserInput" ? "sr-only" : undefined}>
          {accepted
            ? "Response accepted."
            : "Sending response…"}
        </p>
      )}
    </section>
  );
}
