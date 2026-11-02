import { loadPyMuPDF } from './pymupdf-loader.js';

const STRIP_OUTSIDE_CROP_PYTHON = [
  'import json',
  'import pymupdf',
  '',
  '_doc = globals()[_crop_doc_var]',
  '_indices = json.loads(_crop_page_indices_json)',
  'if _indices is None:',
  '    _indices = list(range(_doc.page_count))',
  '',
  '_eps = 1e-3',
  'for _idx in _indices:',
  '    if _idx < 0 or _idx >= _doc.page_count:',
  '        continue',
  '    _page = _doc[_idx]',
  '    _mb = _page.mediabox',
  '    _cb = _page.cropbox',
  '',
  '    _pdf_crop = pymupdf.Rect(_cb.x0, _mb.y1 - _cb.y1, _cb.x1, _mb.y1 - _cb.y0) & _mb',
  '    _mupdf_crop = pymupdf.Rect(_cb.x0 - _mb.x0, _cb.y0, _cb.x1 - _mb.x0, _cb.y1) & pymupdf.Rect(0, 0, _mb.width, _mb.height)',
  '',
  '    if _pdf_crop.is_empty or _mupdf_crop.is_empty:',
  '        continue',
  '',
  '    _page.set_mediabox(_mb)',
  '',
  '    _derot = _page.derotation_matrix',
  '    for _annot in list(_page.annots()):',
  '        if _annot.type[0] != pymupdf.PDF_ANNOT_REDACT and not (_annot.rect * _derot).intersects(_mupdf_crop):',
  '            _page.delete_annot(_annot)',
  '',
  '    _outer = pymupdf.Rect(0, 0, _mb.width, _mb.height)',
  '    for _, _bbox in _page.get_bboxlog():',
  '        _outer |= pymupdf.Rect(_bbox)',
  '',
  '    _strips = []',
  '    if _mupdf_crop.y0 > _eps:',
  '        _strips.append(pymupdf.Rect(_outer.x0, min(0, _outer.y0), _outer.x1, _mupdf_crop.y0))',
  '    if _mupdf_crop.y1 < _mb.height - _eps:',
  '        _strips.append(pymupdf.Rect(_outer.x0, _mupdf_crop.y1, _outer.x1, max(_mb.height, _outer.y1)))',
  '    if _mupdf_crop.x0 > _eps:',
  '        _strips.append(pymupdf.Rect(min(0, _outer.x0), _mupdf_crop.y0, _mupdf_crop.x0, _mupdf_crop.y1))',
  '    if _mupdf_crop.x1 < _mb.width - _eps:',
  '        _strips.append(pymupdf.Rect(_mupdf_crop.x1, _mupdf_crop.y0, max(_mb.width, _outer.x1), _mupdf_crop.y1))',
  '',
  '    _has_redactions = False',
  '    for _strip in _strips:',
  '        if not _strip.is_empty and _strip.width > _eps and _strip.height > _eps:',
  '            _page.add_redact_annot(_strip, fill=False)',
  '            _has_redactions = True',
  '',
  '    if _has_redactions:',
  '        _page.apply_redactions(',
  '            images=pymupdf.PDF_REDACT_IMAGE_PIXELS,',
  '            graphics=pymupdf.PDF_REDACT_LINE_ART_REMOVE_IF_TOUCHED,',
  '            text=pymupdf.PDF_REDACT_TEXT_REMOVE,',
  '        )',
  '',
  '    _page.set_mediabox(_pdf_crop)',
  '    _, _raw_mb = _doc.xref_get_key(_page.xref, "MediaBox")',
  '    if _raw_mb and _raw_mb != "null":',
  '        _doc.xref_set_key(_page.xref, "CropBox", _raw_mb)',
].join('\n');

/**
 * Strips vector graphics, text, images, and annotations outside each cropped
 * page's CropBox using PyMuPDF redactions (with line-art removal if touched),
 * then sets the MediaBox and CropBox to match the kept area.
 */
export async function stripOutsideCropContent(
  pdfBytes: Uint8Array | ArrayBuffer,
  pageIndices?: number[]
): Promise<Uint8Array> {
  const bytes =
    pdfBytes instanceof Uint8Array
      ? new Uint8Array(pdfBytes)
      : new Uint8Array(pdfBytes.slice(0));
  const pymupdf = await loadPyMuPDF();
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const doc = await pymupdf.open(blob);

  try {
    if (!doc.pyodide || !doc.docVar) {
      throw new Error('PyMuPDF document does not expose runtime context.');
    }

    doc.pyodide.globals.set('_crop_doc_var', doc.docVar);
    doc.pyodide.globals.set(
      '_crop_page_indices_json',
      JSON.stringify(pageIndices ?? null)
    );
    try {
      doc.pyodide.runPython(STRIP_OUTSIDE_CROP_PYTHON);
    } finally {
      doc.pyodide.globals.delete('_crop_doc_var');
      doc.pyodide.globals.delete('_crop_page_indices_json');
    }

    return new Uint8Array(doc.save({ garbage: 4, deflate: true, clean: true }));
  } finally {
    doc.close();
  }
}
