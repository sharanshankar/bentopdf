// @vitest-environment node
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { PDFDocument, rgb } from 'pdf-lib';
import type { ClassicPreset } from 'rete';
import type { PyMuPDFDocument, PyMuPDFInstance } from '../js/types/utils-types';
import type { PDFData } from '../js/workflow/types';

interface TestPyodide {
  FS: {
    writeFile(path: string, data: Uint8Array): void;
    unlink(path: string): void;
  };
  globals: {
    set(key: string, value: unknown): void;
    delete(key: string): void;
  };
  runPython(code: string): unknown;
  loadPackage(pkg: string): Promise<void>;
}

const mocks = vi.hoisted(() => ({
  loadPyMuPDF: vi.fn<() => Promise<PyMuPDFInstance>>(),
}));

vi.mock('../js/utils/pymupdf-loader.js', () => ({
  loadPyMuPDF: mocks.loadPyMuPDF,
  isPyMuPDFAvailable: () => true,
}));

vi.mock('../js/utils/load-pdf-document.js', async () => {
  const { PDFDocument: Doc } = await import('pdf-lib');
  return { loadPdfDocument: (bytes: Uint8Array) => Doc.load(bytes) };
});

const { stripOutsideCropContent } = await import('../js/utils/crop-pdf.js');
const { CropNode } = await import('../js/workflow/nodes/crop-node.js');

let pyodide: TestPyodide;
let docCounter = 0;

function createTestDocument(
  py: TestPyodide,
  docVar: string,
  inputPath: string
): PyMuPDFDocument {
  return {
    pageCount: py.runPython(`${docVar}.page_count`) as number,
    pages: ((): never[] => []) as unknown as PyMuPDFDocument['pages'],
    needsPass: false,
    isEncrypted: false,
    authenticate: () => true,
    getPage: () => {
      throw new Error('Not implemented');
    },
    docVar,
    pyodide: py,
    runPython: (code: string) => py.runPython(code),
    save: (options) => {
      const garbage = options?.garbage ?? 1;
      const deflate = options?.deflate !== false ? 'True' : 'False';
      const clean = options?.clean !== false ? 'True' : 'False';
      const b64 = py.runPython(
        `import base64; base64.b64encode(${docVar}.tobytes(garbage=${garbage}, deflate=${deflate}, clean=${clean})).decode('ascii')`
      ) as string;
      return new Uint8Array(Buffer.from(b64, 'base64'));
    },
    close: () => {
      try {
        py.runPython(`${docVar}.close()`);
        py.FS.unlink(inputPath);
      } catch {
        // ignore
      }
    },
  };
}

beforeAll(async () => {
  const extractDir = join(tmpdir(), 'bentopdf-pymupdf-test');
  const assetsDir = join(extractDir, 'assets');
  if (!existsSync(join(assetsDir, 'pyodide.js'))) {
    mkdirSync(extractDir, { recursive: true });
    const tarball = resolve(
      'bentopdf-airgap-bundle/bentopdf-pymupdf-wasm-0.11.16.tgz'
    );
    execFileSync('tar', [
      '-xzf',
      tarball,
      '-C',
      extractDir,
      '--strip-components=1',
    ]);
  }

  const pyodideJsPath = join(assetsDir, 'pyodide.js');
  const req = createRequire(pyodideJsPath);
  (globalThis as Record<string, unknown>).require = req;
  (globalThis as Record<string, unknown>).__dirname = assetsDir;
  (globalThis as Record<string, unknown>).__filename = pyodideJsPath;

  const { loadPyodide } = req(pyodideJsPath) as {
    loadPyodide: (opts: { indexURL: string }) => Promise<TestPyodide>;
  };
  pyodide = await loadPyodide({ indexURL: `${assetsDir}/` });
  await pyodide.loadPackage(
    join(assetsDir, 'pymupdf-1.26.3-cp313-none-pyodide_2025_0_wasm32.whl')
  );
  pyodide.runPython('import pymupdf');

  mocks.loadPyMuPDF.mockImplementation(
    async () =>
      ({
        open: async (blob: Blob) => {
          const id = ++docCounter;
          const docVar = `_test_doc_${id}`;
          const inputPath = `/test_input_${id}.pdf`;
          const buf = new Uint8Array(await blob.arrayBuffer());
          pyodide.FS.writeFile(inputPath, buf);
          pyodide.runPython(`${docVar} = pymupdf.open("${inputPath}")`);
          return createTestDocument(pyodide, docVar, inputPath);
        },
      }) as unknown as PyMuPDFInstance
  );
}, 60000);

function inspectPdfPage(bytes: Uint8Array, pageIndex = 0) {
  const id = ++docCounter;
  const path = `/inspect_${id}.pdf`;
  pyodide.FS.writeFile(path, bytes);
  try {
    const jsonStr = pyodide.runPython(`
import json, pymupdf
_d = pymupdf.open("${path}")
_p = _d[${pageIndex}]
_res = json.dumps({
    "drawingCount": len(_p.get_drawings()),
    "drawingRects": [[round(x, 2) for x in d["rect"]] for d in _p.get_drawings()],
    "text": _p.get_text().strip(),
    "rect": [round(x, 2) for x in _p.rect],
    "mediabox": [round(x, 2) for x in _p.mediabox],
    "cropbox": [round(x, 2) for x in _p.cropbox],
})
_d.close()
_res
`) as string;
    return JSON.parse(jsonStr) as {
      drawingCount: number;
      drawingRects: number[][];
      text: string;
      rect: number[];
      mediabox: number[];
      cropbox: number[];
    };
  } finally {
    try {
      pyodide.FS.unlink(path);
    } catch {
      // ignore
    }
  }
}

describe('stripOutsideCropContent', () => {
  it('deletes outside and boundary-crossing vector lines while keeping inside vectors and setting MediaBox', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 300]);

    // Inside crop box [50, 50, 250, 250] (width=200, height=200)
    page.drawLine({
      start: { x: 100, y: 100 },
      end: { x: 200, y: 200 },
      thickness: 1,
      color: rgb(0, 0, 0),
    });

    // Completely outside in top, bottom, left, right strips
    page.drawLine({
      start: { x: 60, y: 280 },
      end: { x: 240, y: 280 },
      thickness: 1,
    });
    page.drawLine({
      start: { x: 60, y: 20 },
      end: { x: 240, y: 20 },
      thickness: 1,
    });
    page.drawLine({
      start: { x: 20, y: 60 },
      end: { x: 20, y: 240 },
      thickness: 1,
    });
    page.drawLine({
      start: { x: 280, y: 60 },
      end: { x: 280, y: 240 },
      thickness: 1,
    });

    // Crossing the crop boundary
    page.drawLine({
      start: { x: 20, y: 150 },
      end: { x: 150, y: 150 },
      thickness: 1,
    });
    page.drawLine({
      start: { x: 150, y: 20 },
      end: { x: 150, y: 280 },
      thickness: 1,
    });

    page.drawText('INSIDE_KEEP', { x: 90, y: 140, size: 12 });
    page.drawText('OUTSIDE_DROP', { x: 60, y: 15, size: 12 });

    page.setCropBox(50, 50, 200, 200);
    const croppedBytes = await doc.save();

    const before = inspectPdfPage(croppedBytes);
    expect(before.drawingCount).toBe(7);

    const stripped = await stripOutsideCropContent(croppedBytes, [0]);
    const after = inspectPdfPage(stripped);

    expect(after.drawingCount).toBe(1);
    expect(after.drawingRects).toEqual([[50, 50, 150, 150]]);
    expect(after.text).toBe('INSIDE_KEEP');
    expect(after.rect).toEqual([0, 0, 200, 200]);
    expect(after.mediabox).toEqual([50, 50, 250, 250]);
  });

  it('leaves uncropped pages untouched when pageIndices is provided', async () => {
    const doc = await PDFDocument.create();
    const page1 = doc.addPage([200, 200]);
    page1.drawLine({ start: { x: 10, y: 10 }, end: { x: 30, y: 30 } });
    page1.drawLine({ start: { x: 80, y: 80 }, end: { x: 120, y: 120 } });
    page1.setCropBox(50, 50, 100, 100);

    const page2 = doc.addPage([200, 200]);
    page2.drawLine({ start: { x: 10, y: 10 }, end: { x: 30, y: 30 } });
    page2.drawLine({ start: { x: 80, y: 80 }, end: { x: 120, y: 120 } });

    const stripped = await stripOutsideCropContent(await doc.save(), [0]);

    const p1 = inspectPdfPage(stripped, 0);
    const p2 = inspectPdfPage(stripped, 1);

    expect(p1.drawingCount).toBe(1);
    expect(p1.rect).toEqual([0, 0, 100, 100]);
    expect(p2.drawingCount).toBe(2);
    expect(p2.rect).toEqual([0, 0, 200, 200]);
  });

  it('strips outside content in CropNode workflow node', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    page.drawLine({ start: { x: 10, y: 10 }, end: { x: 30, y: 30 } });
    page.drawLine({ start: { x: 40, y: 100 }, end: { x: 100, y: 100 } });
    page.drawLine({ start: { x: 70, y: 70 }, end: { x: 130, y: 130 } });

    const input: PDFData = {
      type: 'pdf',
      document: doc,
      bytes: new Uint8Array(await doc.save()),
      filename: 'drawing.pdf',
    };

    const node = new CropNode();
    for (const side of ['top', 'bottom', 'left', 'right']) {
      (node.controls[side] as ClassicPreset.InputControl<'number'>).setValue(
        50
      );
    }

    const result = (await node.data({ pdf: [input] })).pdf as PDFData;
    expect(result.filename).toBe('drawing_cropped.pdf');

    const info = inspectPdfPage(result.bytes, 0);
    expect(info.drawingCount).toBe(1);
    expect(info.rect).toEqual([0, 0, 100, 100]);
    expect(info.mediabox).toEqual([50, 50, 150, 150]);
  });
});
