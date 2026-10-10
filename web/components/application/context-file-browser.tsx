"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";

type File = { path: string; text: string };

export function ContextFileBrowser({ paths, files, loadFile, onAttach }: {
  paths: string[]; files: File[]; loadFile: (path: string) => Promise<File>;
  onAttach: (file: File, selection?: { startLine: number; endLine: number; text: string }) => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<File | null>(null);
  const [loading, setLoading] = useState("");
  const [error, setError] = useState("");
  const requestId = useRef(0);
  const codeRef = useRef<HTMLPreElement>(null);
  const matches = paths.filter(path => path.toLowerCase().includes(query.trim().toLowerCase()));

  async function open(path: string) {
    const current = ++requestId.current;
    setError(""); setLoading(path);
    try {
      const file = files.find(item => item.path === path) || await loadFile(path);
      if (current === requestId.current) setSelected(file);
    } catch (cause) {
      if (current === requestId.current) setError(cause instanceof Error ? cause.message : "File could not be read");
    } finally { if (current === requestId.current) setLoading(""); }
  }

  function attach() {
    if (!selected) return;
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    if (!range || selection?.isCollapsed || !codeRef.current?.contains(range.startContainer) ||
      !codeRef.current.contains(range.endContainer)) return onAttach(selected);
    const before = range.cloneRange();
    before.selectNodeContents(codeRef.current);
    before.setEnd(range.startContainer, range.startOffset);
    const startLine = before.toString().split("\n").length;
    const text = range.toString();
    onAttach(selected, { startLine, endLine: startLine + text.split("\n").length - 1, text });
    selection?.removeAllRanges();
  }

  return <div className="mt-5 rounded-xl border border-border-button-default bg-background-primary-default p-3">
    <Input label="Find a file" size="small" placeholder="src/auth" value={query} onChange={setQuery} />
    <p className="mt-3 text-caption-1-regular text-text-tertiary">{matches.length > 20 ? `Showing 20 of ${matches.length} paths. Narrow your search to see more.` : `${matches.length} paths at the imported commit.`}</p>
    <ul className="mt-2 flex flex-col gap-1">{matches.slice(0, 20).map(path => <li key={path}>
      <Button variant="ghost" size="small" className="!h-auto !min-h-9 !w-full !justify-start !whitespace-normal !break-all !text-start"
        aria-pressed={selected?.path === path} onClick={() => void open(path)}>{path}</Button>
    </li>)}</ul>
    {!matches.length && <p className="mt-2 text-body-regular text-text-secondary">No matching files.</p>}
    {loading && <p role="status" className="mt-3 text-body-regular text-text-secondary">Opening {loading}…</p>}
    {error && <p role="alert" className="mt-3 text-body-regular text-text-error-primary">{error}</p>}
    {selected && <div className="mt-4 border-t border-separator-border pt-4">
      <p className="break-all font-mono text-caption-1-semibold text-text-primary">{selected.path}</p>
      <p className="mt-2 text-caption-1-regular text-text-tertiary">Select code to include an excerpt, or add the whole file as a link.</p>
      <Button variant="secondary" size="small" className="mt-3" onClick={attach}>Add to spec</Button>
      <pre ref={codeRef} className="mt-3 whitespace-pre-wrap break-words font-mono text-caption-1-regular text-text-secondary">{selected.text}</pre>
    </div>}
  </div>;
}
