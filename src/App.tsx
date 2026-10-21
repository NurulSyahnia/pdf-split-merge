
import { useState } from "react";
import { PDFDocument } from "pdf-lib";
import JSZip from "jszip";
import {
  Files,
  Scissors,
  Upload,
  Trash2,
  ArrowUp,
  ArrowDown,
  Download,
  ShieldCheck,
  LoaderCircle,
} from "lucide-react";
import "./App.css";

type Tool = "merge" | "split";

type PdfFile = {
  id: string;
  file: File;
  pages: number;
};

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB per PDF

function parseRanges(input: string, pageCount: number): number[][] {
  // "1-3, 5, 8-10" becomes [[1,2,3], [5], [8,9,10]]
  const parts = input.split(",").map((part) => part.trim());

  if (!input.trim() || parts.some((part) => !part)) {
    throw new Error("Enter page ranges, for example 1-3, 5, 8-10.");
  }

  const ranges = parts.map((part) => {
    const match = part.match(/^(\d+)(?:\s*-\s*(\d+))?$/);

    if (!match) {
      throw new Error(`Invalid page range: "${part}".`);
    }

    const start = Number(match[1]);
    const end = Number(match[2] ?? match[1]);

    if (
      start < 1 ||
      end < start ||
      end > pageCount
    ) {
      throw new Error(
        `Range "${part}" is invalid. This PDF has ${pageCount} pages.`,
      );
    }

    return Array.from(
      { length: end - start + 1 },
      (_, index) => start + index,
    );
  });

  const usedPages = new Set<number>();

  for (const range of ranges) {
    for (const page of range) {
      if (usedPages.has(page)) {
        throw new Error(`Page ${page} appears more than once.`);
      }

      usedPages.add(page);
    }
  }

  return ranges;
}

async function readPdf(file: File): Promise<PDFDocument> {
  if (file.type !== "application/pdf" &&
      !file.name.toLowerCase().endsWith(".pdf")) {
    throw new Error(`${file.name} is not a PDF file.`);
  }

  if (file.size > MAX_FILE_SIZE) {
    throw new Error(`${file.name} exceeds the 100 MB limit.`);
  }

  if (file.size === 0) {
    throw new Error(`${file.name} is empty.`);
  }

  try {
    const bytes = await file.arrayBuffer();
    return await PDFDocument.load(bytes, {
      updateMetadata: false,
    });
  } catch {
    throw new Error(
      `Cannot read ${file.name}. It may be damaged, encrypted, or unsupported.`,
    );
  }
}

function downloadBytes(bytes: Uint8Array, name: string) {
  const blob = new Blob([bytes as BlobPart], {
    type: "application/pdf",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");

  anchor.href = url;
  anchor.download = name;
  anchor.click();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function App() {
  const [tool, setTool] = useState<Tool>("merge");
  const [files, setFiles] = useState<PdfFile[]>([]);
  const [splitFile, setSplitFile] = useState<File | null>(null);
  const [splitPages, setSplitPages] = useState<number | null>(null);
  const [ranges, setRanges] = useState("1-3, 4-6");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  function resetMessages() {
    setMessage("");
    setError("");
  }

  async function addFiles(list: FileList | null) {
    if (!list) return;

    resetMessages();

    const incoming = Array.from(list);
    const existing = new Set(files.map((item) => item.file.name));
    const next: PdfFile[] = [];

    try {
      for (const file of incoming) {
        if (existing.has(file.name)) {
          throw new Error(
            `${file.name} is already in the merge list. Rename duplicate files first.`,
          );
        }

        const pdf = await readPdf(file);
        next.push({
          id: crypto.randomUUID(),
          file,
          pages: pdf.getPageCount(),
        });

        existing.add(file.name);
      }

      setFiles((current) => [...current, ...next]);
      setMessage(`${next.length} PDF file(s) added.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add PDF.");
    }
  }

  async function chooseSplitFile(file?: File) {
    if (!file) return;

    resetMessages();

    try {
      const pdf = await readPdf(file);
      setSplitFile(file);
      setSplitPages(pdf.getPageCount());
      setRanges(`1-${pdf.getPageCount()}`);
      setMessage(`Loaded ${pdf.getPageCount()} pages.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read PDF.");
    }
  }

  function moveFile(index: number, direction: -1 | 1) {
    const destination = index + direction;

    if (destination < 0 || destination >= files.length) return;

    setFiles((current) => {
      const updated = [...current];
      [updated[index], updated[destination]] = [
        updated[destination],
        updated[index],
      ];
      return updated;
    });
  }

  async function mergePdfs() {
    resetMessages();

    if (files.length < 2) {
      setError("Select at least two PDF files to merge.");
      return;
    }

    setBusy(true);

    try {
      const merged = await PDFDocument.create();

      for (const item of files) {
        const source = await readPdf(item.file);
        const pages = await merged.copyPages(
          source,
          source.getPageIndices(),
        );

        pages.forEach((page) => merged.addPage(page));
      }

      const bytes = await merged.save();
      downloadBytes(bytes, "merged.pdf");
      setMessage("Your merged PDF is ready!");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Merge failed.");
    } finally {
      setBusy(false);
    }
  }

  async function splitPdf() {
    resetMessages();

    if (!splitFile || splitPages === null) {
      setError("Choose a PDF file first.");
      return;
    }

    setBusy(true);

    try {
      const source = await readPdf(splitFile);
      const groups = parseRanges(ranges, source.getPageCount());

      if (groups.length === 1) {
        const output = await PDFDocument.create();
        const pages = await output.copyPages(source, groups[0].map(
          (page) => page - 1,
        ));

        pages.forEach((page) => output.addPage(page));

        downloadBytes(
          await output.save(),
          `${splitFile.name.replace(/\.pdf$/i, "")}_split.pdf`,
        );
      } else {
        const zip = new JSZip();

        for (let i = 0; i < groups.length; i++) {
          const output = await PDFDocument.create();
          const pages = await output.copyPages(
            source,
            groups[i].map((page) => page - 1),
          );

          pages.forEach((page) => output.addPage(page));

          zip.file(
            `part-${i + 1}.pdf`,
            await output.save(),
          );
        }

        const zipBlob = await zip.generateAsync({
          type: "blob",
        });

        const url = URL.createObjectURL(zipBlob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = "split-pdfs.zip";
        anchor.click();

        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }

      setMessage(`Successfully created ${groups.length} PDF part(s).`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Split failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="app">
      <header className="header">
        <a className="brand" href="#">
          <span className="brand-icon"><Files size={24} /></span>
          <span>PDF<span className="brand-accent">Tools</span></span>
        </a>
        <span className="privacy">
          <ShieldCheck size={16} /> Files stay on your device
        </span>
      </header>

      <section className="hero">
        <p className="eyebrow">SIMPLE. PRIVATE. FREE.</p>
        <h1>Your PDF tools,<br />all in one place.</h1>
        <p className="subtitle">
          Merge documents or split pages directly in your browser.
          No account or upload required.
        </p>
      </section>

      <nav className="tabs" aria-label="PDF tools">
        <button
          className={tool === "merge" ? "tab active" : "tab"}
          onClick={() => { setTool("merge"); resetMessages(); }}
        >
          <Files size={18} /> Merge PDF
        </button>
        <button
          className={tool === "split" ? "tab active" : "tab"}
          onClick={() => { setTool("split"); resetMessages(); }}
        >
          <Scissors size={18} /> Split PDF
        </button>
      </nav>

      <section className="workspace">
        {tool === "merge" ? (
          <>
            <div className="section-heading">
              <div>
                <h2>Merge PDF files</h2>
                <p>Combine files in the order you choose.</p>
              </div>
              <span className="count">{files.length} files</span>
            </div>

            <label className="dropzone">
              <Upload size={30} />
              <strong>Choose PDF files</strong>
              <span>Click to browse your device</span>
              <input
                type="file"
                accept=".pdf,application/pdf"
                multiple
                onChange={(e) => {
                  void addFiles(e.target.files);
                  e.currentTarget.value = "";
                }}
              />
            </label>

            {files.length > 0 && (
              <div className="file-list">
                {files.map((item, index) => (
                  <div className="file-row" key={item.id}>
                    <span className="pdf-badge">PDF</span>
                    <div className="file-info">
                      <strong>{item.file.name}</strong>
                      <span>
                        {item.pages} pages · {(item.file.size / 1024 / 1024).toFixed(2)} MB
                      </span>
                    </div>
                    <div className="file-actions">
                      <button
                        className="icon-button"
                        title="Move up"
                        aria-label="Move up"
                        disabled={index === 0}
                        onClick={() => moveFile(index, -1)}
                      ><ArrowUp size={16} /></button>
                      <button
                        className="icon-button"
                        title="Move down"
                        aria-label="Move down"
                        disabled={index === files.length - 1}
                        onClick={() => moveFile(index, 1)}
                      ><ArrowDown size={16} /></button>
                      <button
                        className="icon-button danger"
                        title="Remove file"
                        aria-label="Remove file"
                        onClick={() => setFiles((current) =>
                          current.filter((f) => f.id !== item.id)
                        )}
                      ><Trash2 size={16} /></button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <button
              className="primary-button"
              disabled={busy || files.length < 2}
              onClick={() => void mergePdfs()}
            >
              {busy ? <LoaderCircle className="spin" size={18} /> : <Download size={18} />}
              {busy ? "Processing..." : "Merge and download"}
            </button>
          </>
        ) : (
          <>
            <div className="section-heading">
              <div>
                <h2>Split a PDF</h2>
                <p>Extract pages into separate PDF files.</p>
              </div>
            </div>

            <label className="dropzone">
              <Upload size={30} />
              <strong>{splitFile ? splitFile.name : "Choose a PDF file"}</strong>
              <span>
                {splitPages !== null
                  ? `${splitPages} pages · Click to change file`
                  : "Click to browse your device"}
              </span>
              <input
                type="file"
                accept=".pdf,application/pdf"
                onChange={(e) => {
                  void chooseSplitFile(e.target.files?.[0]);
                  e.currentTarget.value = "";
                }}
              />
            </label>

            {splitPages !== null && (
              <div className="range-box">
                <label htmlFor="page-ranges">Page ranges</label>
                <input
                  id="page-ranges"
                  value={ranges}
                  onChange={(e) => setRanges(e.target.value)}
                  placeholder="e.g. 1-3, 4-6, 7"
                />
                <p>
                  Separate ranges with commas. Each range becomes a PDF
                  in a ZIP file when you specify multiple ranges.
                </p>
                <div className="examples">
                  <button onClick={() => setRanges(`1-${splitPages}`)}>
                    All pages
                  </button>
                  <button onClick={() => setRanges(
                    Array.from({ length: splitPages }, (_, i) => i + 1).join(", ")
                  )}>
                    Every page separately
                  </button>
                </div>
              </div>
            )}

            <button
              className="primary-button"
              disabled={busy || !splitFile}
              onClick={() => void splitPdf()}
            >
              {busy ? <LoaderCircle className="spin" size={18} /> : <Scissors size={18} />}
              {busy ? "Processing..." : "Split and download"}
            </button>
          </>
        )}

        {error && <p className="notice error" role="alert">{error}</p>}
        {message && <p className="notice success" role="status">{message}</p>}

        <p className="privacy-note">
          <ShieldCheck size={16} />
          PDF processing happens locally in this browser. Files are not
          uploaded to a PDF processing server.
        </p>
      </section>

      <footer>
        Built for simple, private PDF tasks.
      </footer>
    </main>
  );
}
