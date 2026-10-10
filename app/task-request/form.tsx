'use client';
import { useId } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import type { TaskRequestFile, TaskRequestSpec, TaskRequestValues } from '../../lib/task-requests';
export function FormMarkdown({ text }: {
    text: string;
}) {
    return <div className="task-request-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a> }}>{text}</ReactMarkdown></div>;
}
export function TaskRequestFields({ spec, values, files = [], disabled = false, preview = false, onChange, onFile, privateFields, privateImages, onPrivateImage }: {
    spec: TaskRequestSpec;
    values: TaskRequestValues;
    files?: TaskRequestFile[];
    disabled?: boolean;
    preview?: boolean;
    onChange?: (id: string, value: string | string[]) => void;
    onFile?: (id: string, file: File) => void;
    privateFields?: React.RefObject<Record<string, HTMLInputElement | null>>;
    privateImages?: Record<string, File>;
    onPrivateImage?: (id: string, file: File | undefined) => void;
}) {
    const prefix = useId();
    const fields = (groupId: string | undefined) => spec.fields.filter(f => f.groupId === groupId).map(f => {
        const id = `${prefix}-${f.id}`, privateField = f.kind.startsWith('secure-');
        return <div key={f.id} className="task-request-field"><label htmlFor={id}>{f.label}{f.required && <span> · Required</span>}{privateField && <span> · Private</span>}</label>
      {f.notes && <FormMarkdown text={f.notes}/>}
      {f.kind === 'text' ? <input id={id} disabled={disabled || preview} required={f.required} maxLength={4096} value={String(values[f.id] ?? '')} onChange={e => onChange?.(f.id, e.target.value)}/>
                : f.kind === 'long-text' ? <textarea id={id} disabled={disabled || preview} required={f.required} rows={3} maxLength={16000} value={String(values[f.id] ?? '')} onChange={e => onChange?.(f.id, e.target.value)}/>
                    : f.kind === 'choice' ? <select id={id} disabled={disabled || preview} required={f.required} value={Array.isArray(values[f.id]) ? values[f.id][0] ?? '' : ''} onChange={e => onChange?.(f.id, e.target.value ? [e.target.value] : [])}><option value="">Choose…</option>{f.choices?.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}</select>
                        : f.kind === 'secure-text' ? <input id={id} type="password" ref={node => {
                                if (privateFields)
                                    privateFields.current[f.id] = node;
                            }} disabled={disabled || preview} required={f.required} maxLength={4096} autoComplete="off" data-lpignore="true" data-1p-ignore spellCheck={false}/>
                            : <input id={id} type="file" disabled={disabled || preview} accept={f.kind === 'image' || f.kind === 'secure-image' ? 'image/png,image/jpeg,image/webp' : undefined} onChange={e => {
                                    const file = e.target.files?.[0];
                                    if (f.kind === 'secure-image')
                                        onPrivateImage?.(f.id, file);
                                    else if (file)
                                        onFile?.(f.id, file);
                                }}/>}
      {files.filter(file => file.fieldId === f.id).map(file => <small key={file.id}>{file.name} · {file.ready ? 'Ready' : 'Awaiting confirmation'}</small>)}
      {privateImages?.[f.id] && <small>Private image selected · memory only</small>}
    </div>;
    });
    return <><FormMarkdown text={spec.instructions}/>{spec.context && <section aria-label="Shared context"><h3>Shared context</h3><FormMarkdown text={spec.context}/></section>}{fields(undefined)}{spec.groups.map(g => <fieldset key={g.id}><legend>{g.label}</legend>{g.notes && <FormMarkdown text={g.notes}/>} {fields(g.id)}</fieldset>)}
    {spec.secure && <aside><strong>Private input</strong><p>{spec.secure.purpose}</p><p>Permitted destination: {spec.secure.destination.label}{spec.secure.destination.origin && <> · {spec.secure.destination.origin}</>}</p><p>Encrypted transfer lasts at most one hour. Closing or reloading discards private entry. Ordinary saved answers exclude private fields and images. An unconfirmed transfer, expiry or bridge restart needs owner review before fresh private entry.</p></aside>}</>;
}
export const requestStatus: Record<string, string> = { draft: 'Draft', published: 'Open for one contributor', revoked: 'Revoked', expired: 'Expired', received: 'Submission received', 'awaiting-bot': 'Awaiting bot', 'native-accepted': 'Native intake accepted', 'response-sent': 'Answer response sent', 'needs-review': 'Needs owner review', uncertain: 'Delivery unconfirmed', 'private-unavailable': 'Private input unavailable' };
