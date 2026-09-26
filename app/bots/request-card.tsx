"use client";
import { useState } from "react";
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
  value,
  onChange,
}: {
  name: string;
  schema: JsonSchema;
  required: boolean;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  if (schema.enum)
    return (
      <label>
        {schema.title ?? name}
        <select
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
        </select>
      </label>
    );
  if (schema.type === "boolean")
    return (
      <label className="bots-checkbox">
        <input
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
        <textarea
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
      <input
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
export function RequestCard({
  pending,
  respond,
  disabled,
}: {
  pending: BotRequest;
  respond: (result: unknown) => Promise<void>;
  disabled: boolean;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({}),
    [form, setForm] = useState<Record<string, unknown>>(() => {
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
    [raw, setRaw] = useState(false);
  const request = pending.request;
  async function submit(result: unknown) {
    setBusy(true);
    setError("");
    try {
      await respond(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Response failed.");
      setBusy(false);
    }
  }
  const locked = disabled || busy;
  let content;
  if (request.method === "item/tool/requestUserInput")
    content = (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit({
            answers: Object.fromEntries(
              request.params.questions.map((q) => [
                q.id,
                { answers: [answers[q.id] ?? ""] },
              ]),
            ),
          });
        }}
      >
        {request.params.questions.map((q) => (
          <fieldset key={q.id}>
            <legend>{q.question}</legend>
            {q.options?.map((option) => (
              <label key={option.label} className="bots-option">
                <input
                  type="radio"
                  name={pending.key + q.id}
                  checked={answers[q.id] === option.label}
                  onChange={() =>
                    setAnswers({ ...answers, [q.id]: option.label })
                  }
                />
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.description}</small>
                </span>
              </label>
            ))}
            <input
              type={q.isSecret ? "password" : "text"}
              required={!answers[q.id]}
              aria-label={`Answer: ${q.header}`}
              placeholder={
                q.options?.length ? "Or type your answer…" : "Your answer…"
              }
              value={
                q.options?.some((o) => o.label === answers[q.id])
                  ? ""
                  : (answers[q.id] ?? "")
              }
              onChange={(e) =>
                setAnswers({ ...answers, [q.id]: e.target.value })
              }
            />
          </fieldset>
        ))}
        <button className="bots-primary" disabled={locked}>
          Send answers
        </button>
      </form>
    );
  else if (request.method === "mcpServer/elicitation/request") {
    const p = request.params;
    if (p.mode === "url")
      content = (
        <>
          <p>{p.message}</p>
          <a
            className="bots-primary"
            target="_blank"
            rel="noreferrer"
            href={/^https?:\/\//.test(p.url) ? p.url : undefined}
          >
            Open authorization
          </a>
          <div className="bots-request-actions">
            <button
              disabled={locked}
              onClick={() => void submit({ action: "accept", content: null })}
            >
              I’ve completed this
            </button>
            <button
              disabled={locked}
              onClick={() => void submit({ action: "cancel", content: null })}
            >
              Cancel
            </button>
          </div>
        </>
      );
    else if (p.mode === "openai/userVerification")
      content = (
        <>
          <p>{p.title}</p>
          <p>{p.description}</p>
          <p>Device verification is unavailable on this Linux VM.</p>
          <button
            disabled={locked}
            onClick={() => void submit({ action: "cancel", content: null })}
          >
            Cancel request
          </button>
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
              type="checkbox"
              checked={raw}
              onChange={(e) => setRaw(e.target.checked)}
            />
            Edit response as JSON
          </label>
          {!raw && schema.properties ? (
            Object.entries(schema.properties).map(([key, field]) => (
              <FormField
                key={key}
                name={key}
                schema={field}
                required={schema.required?.includes(key) ?? false}
                value={form[key] ?? field.default}
                onChange={(value) => setForm({ ...form, [key]: value })}
              />
            ))
          ) : (
            <label>
              Response (JSON)
              <textarea
                required
                defaultValue={JSON.stringify(form, null, 2)}
                onChange={(e) => {
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
            <button className="bots-primary" disabled={locked}>
              Submit
            </button>
            <button
              type="button"
              disabled={locked}
              onClick={() => void submit({ action: "decline", content: null })}
            >
              Decline
            </button>
            <button
              type="button"
              disabled={locked}
              onClick={() => void submit({ action: "cancel", content: null })}
            >
              Cancel
            </button>
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
          <button
            className="bots-primary"
            disabled={locked}
            onClick={() =>
              void submit({
                permissions: request.params.permissions,
                scope: "turn",
              })
            }
          >
            Allow this turn
          </button>
          <button
            disabled={locked}
            onClick={() =>
              void submit({
                permissions: request.params.permissions,
                scope: "session",
              })
            }
          >
            Allow for session
          </button>
          <button
            disabled={locked}
            onClick={() => void submit({ permissions: {}, scope: "turn" })}
          >
            Decline
          </button>
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
            <button
              key={i}
              className={i === 0 ? "bots-primary" : ""}
              disabled={locked}
              onClick={() => void submit({ decision })}
            >
              {decisionLabel(decision)}
            </button>
          ))}
        </div>
      </>
    );
  } else content = <p>This request is handled by the bot runtime.</p>;
  return (
    <section className="bots-request" aria-label="Bot needs your input">
      <div className="bots-request-title">Your input is needed</div>
      {content}
      {error && (
        <p role="alert" className="bots-error">
          {error}
        </p>
      )}
    </section>
  );
}
