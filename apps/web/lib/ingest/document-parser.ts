import { JSDOM } from 'jsdom';
import {
  Unzip,
  UnzipInflate,
  UnzipPassThrough,
  type UnzipFile,
} from 'fflate';

export const MAX_INPUT_BYTES = 2 * 1024 * 1024;
export const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
export const MAX_ARCHIVE_OUTPUT_BYTES = 32 * 1024 * 1024;
export const MAX_ARCHIVE_ENTRY_BYTES = 8 * 1024 * 1024;
export const MAX_ARCHIVE_ENTRIES = 2_000;
export const MAX_IMAGES = 6;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const DOCUMENT_TIMEOUT_MS = 30_000;

export type DocumentKind = 'text' | 'pdf' | 'docx' | 'pptx' | 'epub' | 'image';

export type DocumentErrorCode =
  | 'INVALID_INPUT'
  | 'INPUT_TOO_LARGE'
  | 'OUTPUT_TOO_LARGE'
  | 'UNSUPPORTED_TYPE'
  | 'TYPE_MISMATCH'
  | 'INVALID_MAGIC'
  | 'INVALID_UTF8'
  | 'INVALID_ARCHIVE'
  | 'ARCHIVE_ZIP_SLIP'
  | 'ARCHIVE_ENCRYPTED'
  | 'ARCHIVE_ENTRY_LIMIT'
  | 'ARCHIVE_ENTRY_TOO_LARGE'
  | 'ARCHIVE_OUTPUT_LIMIT'
  | 'DECLARATION_MISSING'
  | 'INVALID_XML'
  | 'PDF_PAGE_LIMIT'
  | 'IMAGE_DESCRIBER_REQUIRED'
  | 'IMAGE_DESCRIPTION_FAILED'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'PARSE_FAILED';

export interface ImageToDescribe {
  name: string;
  mime: string;
  data: Uint8Array;
  signal: AbortSignal;
}

export type ImageDescriber = (image: ImageToDescribe) => Promise<string> | string;

export interface ExtractDocumentInput {
  filename: string;
  mime: string;
  data: Uint8Array;
  signal?: AbortSignal;
  describeImage?: ImageDescriber;
}

export interface DocumentExtractError {
  code: DocumentErrorCode;
  message: string;
}

export type ExtractDocumentResult =
  | { ok: true; text: string }
  | { ok: false; error: DocumentExtractError };

const ERROR_MESSAGES: Record<DocumentErrorCode, string> = {
  INVALID_INPUT: 'Invalid document input.',
  INPUT_TOO_LARGE: 'The document is too large.',
  OUTPUT_TOO_LARGE: 'The extracted text is too large.',
  UNSUPPORTED_TYPE: 'This document type is not supported.',
  TYPE_MISMATCH: 'The filename and MIME type do not match.',
  INVALID_MAGIC: 'The document signature is invalid.',
  INVALID_UTF8: 'The document is not valid UTF-8 text.',
  INVALID_ARCHIVE: 'The document archive is invalid.',
  ARCHIVE_ZIP_SLIP: 'The document archive contains an unsafe path.',
  ARCHIVE_ENCRYPTED: 'Encrypted document archives are not supported.',
  ARCHIVE_ENTRY_LIMIT: 'The document archive has too many entries.',
  ARCHIVE_ENTRY_TOO_LARGE: 'A document archive entry is too large.',
  ARCHIVE_OUTPUT_LIMIT: 'The document archive expands beyond the safety limit.',
  DECLARATION_MISSING: 'The document package declaration is incomplete.',
  INVALID_XML: 'The document XML is invalid.',
  PDF_PAGE_LIMIT: 'The PDF has too many pages.',
  IMAGE_DESCRIBER_REQUIRED: 'An image describer is required for this image.',
  IMAGE_DESCRIPTION_FAILED: 'The image could not be described.',
  TIMEOUT: 'Document processing timed out.',
  ABORTED: 'Document processing was cancelled.',
  PARSE_FAILED: 'The document could not be parsed.',
};

class ParseFailure extends Error {
  constructor(readonly code: DocumentErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'ParseFailure';
  }
}

interface ParseContext {
  signal: AbortSignal;
  timedOut: () => boolean;
  check: () => void;
  close: () => void;
}

function createParseContext(external?: AbortSignal): ParseContext {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, DOCUMENT_TIMEOUT_MS);
  const onAbort = () => controller.abort();

  if (external?.aborted) controller.abort();
  else external?.addEventListener('abort', onAbort, { once: true });

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    check: () => {
      if (!controller.signal.aborted) return;
      throw new ParseFailure(timedOut ? 'TIMEOUT' : 'ABORTED');
    },
    close: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    },
  };
}

async function waitWithAbort<T>(promise: Promise<T>, context: ParseContext): Promise<T> {
  context.check();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(new ParseFailure(context.timedOut() ? 'TIMEOUT' : 'ABORTED'));
    };
    context.signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => {
        if (settled) return;
        settled = true;
        context.signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        if (settled) return;
        settled = true;
        context.signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function failureCode(error: unknown, context: ParseContext): ParseFailure {
  if (error instanceof ParseFailure) return error;
  if (context.signal.aborted) return new ParseFailure(context.timedOut() ? 'TIMEOUT' : 'ABORTED');
  return new ParseFailure('PARSE_FAILED');
}

function normalizedMime(mime: string): string {
  return mime.trim().toLowerCase().split(';', 1)[0] ?? '';
}

function extensionOf(filename: string): string {
  const base = filename.replaceAll('\\', '/').split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

const EXTENSION_KIND: Record<string, DocumentKind> = {
  txt: 'text',
  md: 'text',
  markdown: 'text',
  pdf: 'pdf',
  docx: 'docx',
  pptx: 'pptx',
  epub: 'epub',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
  gif: 'image',
};

const MIME_KIND: Record<string, DocumentKind> = {
  'text/plain': 'text',
  'text/markdown': 'text',
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/epub+zip': 'epub',
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/webp': 'image',
  'image/gif': 'image',
};

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

function byteAt(data: Uint8Array, index: number): number {
  return data[index] ?? -1;
}

function startsWithBytes(data: Uint8Array, bytes: readonly number[]): boolean {
  return bytes.every((byte, index) => byteAt(data, index) === byte);
}

function hasPdfMagic(data: Uint8Array): boolean {
  return startsWithBytes(data, [0x25, 0x50, 0x44, 0x46, 0x2d]);
}

function hasZipMagic(data: Uint8Array): boolean {
  return (
    startsWithBytes(data, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWithBytes(data, [0x50, 0x4b, 0x05, 0x06]) ||
    startsWithBytes(data, [0x50, 0x4b, 0x07, 0x08])
  );
}

function hasImageMagic(kind: string, data: Uint8Array): boolean {
  switch (kind) {
    case 'png':
      return startsWithBytes(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'jpeg':
      return startsWithBytes(data, [0xff, 0xd8, 0xff]);
    case 'webp':
      return startsWithBytes(data, [0x52, 0x49, 0x46, 0x46]) &&
        startsWithBytes(data.subarray(8), [0x57, 0x45, 0x42, 0x50]);
    case 'gif':
      return startsWithBytes(data, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
        startsWithBytes(data, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    default:
      return false;
  }
}

function imageKindForExtension(extension: string): string | undefined {
  if (extension === 'jpg' || extension === 'jpeg') return 'jpeg';
  if (extension === 'png' || extension === 'webp' || extension === 'gif') return extension;
  return undefined;
}

function validateType(input: ExtractDocumentInput): DocumentKind {
  if (!input || typeof input.filename !== 'string' || typeof input.mime !== 'string' ||
      !(input.data instanceof Uint8Array)) throw new ParseFailure('INVALID_INPUT');
  if (input.data.byteLength > MAX_INPUT_BYTES) throw new ParseFailure('INPUT_TOO_LARGE');

  const extension = extensionOf(input.filename);
  const mime = normalizedMime(input.mime);
  const extKind = EXTENSION_KIND[extension];
  const mimeKind = MIME_KIND[mime];
  if (!extKind || !mimeKind) throw new ParseFailure('UNSUPPORTED_TYPE');
  if (extKind !== mimeKind) throw new ParseFailure('TYPE_MISMATCH');

  const data = input.data;
  if (extKind === 'text') {
    decodeUtf8(data);
  } else if (extKind === 'pdf' && !hasPdfMagic(data)) {
    throw new ParseFailure('INVALID_MAGIC');
  } else if ((extKind === 'docx' || extKind === 'pptx' || extKind === 'epub') && !hasZipMagic(data)) {
    throw new ParseFailure('INVALID_MAGIC');
  } else if (extKind === 'image') {
    const imageKind = imageKindForExtension(extension);
    if (!imageKind || !hasImageMagic(imageKind, data)) throw new ParseFailure('INVALID_MAGIC');
    if (mime !== IMAGE_MIME_BY_EXTENSION[extension]) throw new ParseFailure('TYPE_MISMATCH');
  }
  return extKind;
}

function decodeUtf8(data: Uint8Array): string {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    if (text.includes('\0')) throw new ParseFailure('INVALID_UTF8');
    return text.replace(/^\uFEFF/, '');
  } catch (error) {
    if (error instanceof ParseFailure) throw error;
    throw new ParseFailure('INVALID_UTF8');
  }
}

class OutputBuffer {
  private readonly chunks: string[] = [];
  private bytes = 0;

  add(value: string): void {
    const size = new TextEncoder().encode(value).byteLength;
    if (this.bytes + size > MAX_OUTPUT_BYTES) throw new ParseFailure('OUTPUT_TOO_LARGE');
    this.bytes += size;
    this.chunks.push(value);
  }

  text(): string {
    return this.chunks.join('');
  }
}

function readU16(data: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > data.length) throw new ParseFailure('INVALID_ARCHIVE');
  return byteAt(data, offset) | (byteAt(data, offset + 1) << 8);
}

function readU32(data: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > data.length) throw new ParseFailure('INVALID_ARCHIVE');
  return (
    byteAt(data, offset) |
    (byteAt(data, offset + 1) << 8) |
    (byteAt(data, offset + 2) << 16) |
    (byteAt(data, offset + 3) << 24)
  ) >>> 0;
}

function findLastSignature(data: Uint8Array, signature: number): number {
  for (let index = data.length - 4; index >= 0; index -= 1) {
    if (readU32(data, index) === signature) return index;
  }
  return -1;
}

function isUnsafeArchivePath(name: string): boolean {
  const normalized = name.replaceAll('\\', '/');
  return normalized.includes('\0') || normalized.startsWith('/') ||
    normalized.startsWith('//') || /^[a-zA-Z]:\//.test(normalized) ||
    normalized.split('/').some(segment => segment === '..');
}

function preflightZip(data: Uint8Array): void {
  const eocd = findLastSignature(data, 0x06054b50);
  if (eocd < 0) return;
  const commentLength = readU16(data, eocd + 20);
  if (eocd + 22 + commentLength > data.length) throw new ParseFailure('INVALID_ARCHIVE');
  const entryCount = readU16(data, eocd + 10);
  const directorySize = readU32(data, eocd + 12);
  const directoryOffset = readU32(data, eocd + 16);
  if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw new ParseFailure('INVALID_ARCHIVE');
  }
  if (entryCount > MAX_ARCHIVE_ENTRIES || directoryOffset + directorySize > data.length) {
    throw new ParseFailure(entryCount > MAX_ARCHIVE_ENTRIES ? 'ARCHIVE_ENTRY_LIMIT' : 'INVALID_ARCHIVE');
  }

  let cursor = directoryOffset;
  let declaredOutput = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (readU32(data, cursor) !== 0x02014b50) throw new ParseFailure('INVALID_ARCHIVE');
    const flags = readU16(data, cursor + 8);
    if ((flags & 1) !== 0) throw new ParseFailure('ARCHIVE_ENCRYPTED');
    const compressedSize = readU32(data, cursor + 20);
    const originalSize = readU32(data, cursor + 24);
    const nameLength = readU16(data, cursor + 28);
    const extraLength = readU16(data, cursor + 30);
    const entryCommentLength = readU16(data, cursor + 32);
    if (originalSize > MAX_ARCHIVE_ENTRY_BYTES) throw new ParseFailure('ARCHIVE_ENTRY_TOO_LARGE');
    declaredOutput += originalSize;
    if (declaredOutput > MAX_ARCHIVE_OUTPUT_BYTES) throw new ParseFailure('ARCHIVE_OUTPUT_LIMIT');
    if (cursor + 46 + nameLength + extraLength + entryCommentLength > data.length) {
      throw new ParseFailure('INVALID_ARCHIVE');
    }
    if (compressedSize > data.length) throw new ParseFailure('INVALID_ARCHIVE');
    cursor += 46 + nameLength + extraLength + entryCommentLength;
  }
}

interface ArchiveEntry {
  data: Uint8Array;
  compression: number;
}

interface Archive {
  entries: Map<string, ArchiveEntry>;
  order: string[];
}

function concatBytes(chunks: readonly Uint8Array[], size: number): Uint8Array {
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function unzipArchive(data: Uint8Array, context: ParseContext): Archive {
  preflightZip(data);
  const entries = new Map<string, ArchiveEntry>();
  const order: string[] = [];
  let entryCount = 0;
  let outputBytes = 0;

  const zip = new Unzip((file: UnzipFile) => {
    context.check();
    entryCount += 1;
    if (entryCount > MAX_ARCHIVE_ENTRIES) throw new ParseFailure('ARCHIVE_ENTRY_LIMIT');
    if (isUnsafeArchivePath(file.name)) throw new ParseFailure('ARCHIVE_ZIP_SLIP');
    if (file.originalSize !== undefined && file.originalSize > MAX_ARCHIVE_ENTRY_BYTES) {
      throw new ParseFailure('ARCHIVE_ENTRY_TOO_LARGE');
    }

    const chunks: Uint8Array[] = [];
    let entryBytes = 0;
    file.ondata = (error, chunk, final) => {
      if (error) throw new ParseFailure('INVALID_ARCHIVE');
      context.check();
      entryBytes += chunk.length;
      outputBytes += chunk.length;
      if (entryBytes > MAX_ARCHIVE_ENTRY_BYTES) throw new ParseFailure('ARCHIVE_ENTRY_TOO_LARGE');
      if (outputBytes > MAX_ARCHIVE_OUTPUT_BYTES) throw new ParseFailure('ARCHIVE_OUTPUT_LIMIT');
      chunks.push(chunk.slice());
      if (final) {
        entries.set(file.name, { data: concatBytes(chunks, entryBytes), compression: file.compression });
        order.push(file.name);
      }
    };
    file.start();
  });
  zip.register(UnzipPassThrough);
  zip.register(UnzipInflate);

  try {
    for (let offset = 0; offset < data.length; offset += 64 * 1024) {
      context.check();
      zip.push(data.subarray(offset, Math.min(offset + 64 * 1024, data.length)),
        offset + 64 * 1024 >= data.length);
    }
  } catch (error) {
    throw error instanceof ParseFailure ? error : new ParseFailure('INVALID_ARCHIVE');
  }
  return { entries, order };
}

function archiveEntry(archive: Archive, name: string): Uint8Array {
  const entry = archive.entries.get(name);
  if (!entry) throw new ParseFailure('DECLARATION_MISSING');
  return entry.data;
}

function xmlLocalName(element: Element): string {
  return (element.localName || element.tagName.split(':').pop() || '').toLowerCase();
}

function allElements(root: Document | Element, name: string): Element[] {
  return Array.from(root.getElementsByTagName('*')).filter(element => name === '*' || xmlLocalName(element) === name);
}

function elementText(element: Element): string {
  return (element.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function withXml<T>(data: Uint8Array, callback: (document: Document) => T): T {
  let dom: JSDOM | undefined;
  try {
    dom = new JSDOM(decodeUtf8(data), { contentType: 'text/xml' });
    const document = dom.window.document;
    if (!document.documentElement || xmlLocalName(document.documentElement) === 'parsererror' ||
        allElements(document, 'parsererror').length > 0) throw new ParseFailure('INVALID_XML');
    return callback(document);
  } catch (error) {
    if (error instanceof ParseFailure) throw error;
    throw new ParseFailure('INVALID_XML');
  } finally {
    dom?.window.close();
  }
}

function paragraphText(element: Element, textName = 't'): string {
  return allElements(element, '*')
    .filter(child => xmlLocalName(child) === textName || xmlLocalName(child) === 'tab' || xmlLocalName(child) === 'br')
    .map(child => xmlLocalName(child) === 'tab' ? '\t' : xmlLocalName(child) === 'br' ? '\n' : child.textContent ?? '')
    .join('')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function appendDocxTable(output: OutputBuffer, table: Element): void {
  for (const row of allElements(table, 'tr')) {
    const cells = allElements(row, 'tc').map(cell =>
      allElements(cell, 'p').map(element => paragraphText(element)).filter(Boolean).join(' '),
    );
    if (cells.some(Boolean)) output.add(`${cells.join(' | ')}\n`);
  }
}

async function extractDocx(archive: Archive, context: ParseContext, describeImage?: ImageDescriber): Promise<string> {
  withXml(archiveEntry(archive, '[Content_Types].xml'), document => {
    if (xmlLocalName(document.documentElement) !== 'types') throw new ParseFailure('DECLARATION_MISSING');
  });
  const documentXml = archiveEntry(archive, 'word/document.xml');
  const output = new OutputBuffer();
  withXml(documentXml, document => {
    if (xmlLocalName(document.documentElement) !== 'document') throw new ParseFailure('DECLARATION_MISSING');
    const body = allElements(document, 'body')[0];
    if (!body) throw new ParseFailure('DECLARATION_MISSING');
    for (const child of Array.from(body.children)) {
      const name = xmlLocalName(child);
      if (name === 'p') {
        const text = paragraphText(child);
        if (text) output.add(`${text}\n`);
      } else if (name === 'tbl') {
        appendDocxTable(output, child);
      }
    }
  });
  await appendArchiveImages(output, archive, context, describeImage, 'word/media/');
  return output.text();
}

function relationshipMap(document: Document): Map<string, string> {
  const map = new Map<string, string>();
  for (const relationship of allElements(document, 'relationship')) {
    const id = relationship.getAttribute('Id');
    const target = relationship.getAttribute('Target');
    if (id && target) map.set(id, target);
  }
  return map;
}

function normalizeTarget(baseDirectory: string, target: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(target.split('#', 1)[0] ?? '').replaceAll('\\', '/');
  } catch {
    throw new ParseFailure('DECLARATION_MISSING');
  }
  if (!decoded || decoded.startsWith('/') || /^[a-zA-Z]:\//.test(decoded)) {
    throw new ParseFailure('ARCHIVE_ZIP_SLIP');
  }
  const parts = `${baseDirectory}/${decoded}`.split('/');
  const normalized: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!normalized.length) throw new ParseFailure('ARCHIVE_ZIP_SLIP');
      normalized.pop();
    } else {
      normalized.push(part);
    }
  }
  return normalized.join('/');
}

function numericSlideOrder(path: string): number {
  const match = /\/slide(\d+)\.xml$/i.exec(path);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function slideText(document: Document): string {
  return allElements(document, 'p').map(element => paragraphText(element)).filter(Boolean).join('\n');
}

async function extractPptx(archive: Archive, context: ParseContext, describeImage?: ImageDescriber): Promise<string> {
  withXml(archiveEntry(archive, '[Content_Types].xml'), document => {
    if (xmlLocalName(document.documentElement) !== 'types') throw new ParseFailure('DECLARATION_MISSING');
  });
  const presentationXml = archiveEntry(archive, 'ppt/presentation.xml');
  const slideEntries = [...archive.entries.keys()]
    .filter(name => /^ppt\/slides\/slide[^/]+\.xml$/i.test(name));
  if (!slideEntries.length) throw new ParseFailure('DECLARATION_MISSING');

  let slidePaths: string[] = [];
  withXml(presentationXml, document => {
    if (xmlLocalName(document.documentElement) !== 'presentation') throw new ParseFailure('DECLARATION_MISSING');
    const relationshipEntry = archive.entries.get('ppt/_rels/presentation.xml.rels');
    if (relationshipEntry) {
      const relationships = withXml(relationshipEntry.data, relationshipMap);
      const ids = allElements(document, 'sldid')
        .map(element => element.getAttribute('r:id') || element.getAttribute('id'))
        .filter((id): id is string => Boolean(id));
      slidePaths = ids.map(id => {
        const target = relationships.get(id);
        if (!target) throw new ParseFailure('DECLARATION_MISSING');
        return normalizeTarget('ppt', target);
      });
    }
  });
  if (!slidePaths.length) slidePaths = slideEntries.sort((a, b) => numericSlideOrder(a) - numericSlideOrder(b));
  if (slidePaths.some(path => !archive.entries.has(path))) throw new ParseFailure('DECLARATION_MISSING');

  const output = new OutputBuffer();
  for (let index = 0; index < slidePaths.length; index += 1) {
    context.check();
    const path = slidePaths[index];
    if (!path) continue;
    const slide = withXml(archiveEntry(archive, path), document => {
      if (xmlLocalName(document.documentElement) !== 'sld') throw new ParseFailure('INVALID_XML');
      return slideText(document);
    });
    output.add(`## Slide ${index + 1}\n`);
    if (slide) output.add(`${slide}\n`);

    const relsPath = path.replace(/\/([^/]+)$/, '/_rels/$1.rels');
    const rels = archive.entries.get(relsPath);
    if (rels) {
      const notesPath = withXml(rels.data, document => {
        const relationships = relationshipMap(document);
        for (const [id, target] of relationships) {
          const relationship = allElements(document, 'relationship').find(item => item.getAttribute('Id') === id);
          if (relationship?.getAttribute('Type')?.endsWith('/notesSlide')) {
            return normalizeTarget(path.slice(0, path.lastIndexOf('/')), target);
          }
        }
        return undefined;
      });
      if (notesPath && archive.entries.has(notesPath)) {
        const notes = withXml(archiveEntry(archive, notesPath), slideText);
        if (notes) output.add(`### Speaker notes\n${notes}\n`);
      }
    }
    output.add('\n');
  }
  await appendArchiveImages(output, archive, context, describeImage, 'ppt/media/');
  return output.text();
}

function htmlText(data: Uint8Array): string {
  let dom: JSDOM | undefined;
  try {
    dom = new JSDOM(decodeUtf8(data), { contentType: 'text/html' });
    const document = dom.window.document;
    for (const tag of ['script', 'style', 'noscript', 'template']) {
      for (const element of Array.from(document.getElementsByTagName(tag))) element.remove();
    }
    return (document.body ?? document.documentElement).textContent?.replace(/\s+/g, ' ').trim() ?? '';
  } catch (error) {
    if (error instanceof ParseFailure) throw error;
    throw new ParseFailure('INVALID_XML');
  } finally {
    dom?.window.close();
  }
}

function directoryOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

async function extractEpub(archive: Archive, context: ParseContext, describeImage?: ImageDescriber): Promise<string> {
  const mimetype = decodeUtf8(archiveEntry(archive, 'mimetype')).trim();
  if (mimetype !== 'application/epub+zip') throw new ParseFailure('DECLARATION_MISSING');
  if (archive.order[0] !== 'mimetype') throw new ParseFailure('DECLARATION_MISSING');

  const containerPath = 'META-INF/container.xml';
  const opfPath = withXml(archiveEntry(archive, containerPath), document => {
    if (xmlLocalName(document.documentElement) !== 'container') throw new ParseFailure('DECLARATION_MISSING');
    const rootfile = allElements(document, 'rootfile')[0];
    const fullPath = rootfile?.getAttribute('full-path');
    if (!fullPath) throw new ParseFailure('DECLARATION_MISSING');
    return normalizeTarget('', fullPath);
  });
  const output = new OutputBuffer();
  const spineItems = withXml(archiveEntry(archive, opfPath), document => {
    if (xmlLocalName(document.documentElement) !== 'package') throw new ParseFailure('DECLARATION_MISSING');
    const manifest = new Map<string, { href: string; mediaType: string }>();
    for (const item of allElements(document, 'item')) {
      const id = item.getAttribute('id');
      const href = item.getAttribute('href');
      const mediaType = item.getAttribute('media-type');
      if (id && href && mediaType) manifest.set(id, { href, mediaType });
    }
    const spine = allElements(document, 'spine')[0];
    if (!spine) throw new ParseFailure('DECLARATION_MISSING');
    return allElements(spine, 'itemref').map(itemref => {
      const idref = itemref.getAttribute('idref');
      const item = idref ? manifest.get(idref) : undefined;
      if (!item) throw new ParseFailure('DECLARATION_MISSING');
      return { path: normalizeTarget(directoryOf(opfPath), item.href), mediaType: item.mediaType };
    });
  });
  if (!spineItems.length) throw new ParseFailure('DECLARATION_MISSING');

  for (let index = 0; index < spineItems.length; index += 1) {
    context.check();
    const item = spineItems[index];
    if (!item || !archive.entries.has(item.path)) throw new ParseFailure('DECLARATION_MISSING');
    output.add(`## Chapter ${index + 1}\n`);
    if (item.mediaType === 'application/xhtml+xml' || item.mediaType === 'text/html') {
      const text = htmlText(archiveEntry(archive, item.path));
      if (text) output.add(`${text}\n`);
    } else if (item.mediaType === 'text/plain') {
      output.add(`${decodeUtf8(archiveEntry(archive, item.path)).trim()}\n`);
    }
    output.add('\n');
  }
  await appendArchiveImages(output, archive, context, describeImage);
  return output.text();
}

function imageEntryForPath(path: string, data: Uint8Array): { mime: string; kind: string } | undefined {
  const extension = extensionOf(path);
  const mime = IMAGE_MIME_BY_EXTENSION[extension];
  const kind = imageKindForExtension(extension);
  return mime && kind && hasImageMagic(kind, data) ? { mime, kind } : undefined;
}

function imageName(path: string): string {
  return path.replaceAll('\\', '/').split('/').pop() || 'image';
}

async function describeImage(
  image: ImageToDescribe,
  describer: ImageDescriber | undefined,
  context: ParseContext,
  embedded: boolean,
): Promise<string> {
  if (!describer) {
    if (!embedded) throw new ParseFailure('IMAGE_DESCRIBER_REQUIRED');
    return '[Image description unavailable]';
  }
  try {
    const result = await waitWithAbort(
      Promise.resolve().then(() => describer({ ...image, data: image.data.slice() })),
      context,
    );
    if (typeof result !== 'string' || !result.trim()) {
      if (!embedded) throw new ParseFailure('IMAGE_DESCRIPTION_FAILED');
      return '[Image description unavailable]';
    }
    return result.trim();
  } catch (error) {
    if (error instanceof ParseFailure && (error.code === 'TIMEOUT' || error.code === 'ABORTED')) throw error;
    if (!embedded) throw new ParseFailure('IMAGE_DESCRIPTION_FAILED');
    return '[Image description unavailable]';
  }
}

async function appendArchiveImages(
  output: OutputBuffer,
  archive: Archive,
  context: ParseContext,
  describer: ImageDescriber | undefined,
  prefix?: string,
): Promise<void> {
  let count = 0;
  let bytes = 0;
  for (const path of archive.order) {
    context.check();
    if (prefix && !path.startsWith(prefix)) continue;
    const entry = archive.entries.get(path);
    const image = entry && imageEntryForPath(path, entry.data);
    if (!image || count >= MAX_IMAGES || bytes + entry.data.length > MAX_IMAGE_BYTES) continue;
    count += 1;
    bytes += entry.data.length;
    const description = await describeImage({
      name: imageName(path),
      mime: image.mime,
      data: entry.data,
      signal: context.signal,
    }, describer, context, true);
    output.add(`\n### Image: ${imageName(path)}\n${description}\n`);
  }
}

async function extractPdf(data: Uint8Array, context: ParseContext): Promise<string> {
  const pdfjs = await waitWithAbort(import('pdfjs-dist/legacy/build/pdf.mjs'), context);
  const loadingTask = pdfjs.getDocument({
    data: data.slice(),
    enableXfa: false,
    disableFontFace: true,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    stopAtErrors: true,
  });
  try {
    const document = await waitWithAbort(loadingTask.promise, context);
    if (document.numPages > 100) throw new ParseFailure('PDF_PAGE_LIMIT');
    const output = new OutputBuffer();
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      context.check();
      const page = await waitWithAbort(document.getPage(pageNumber), context);
      const textContent = await waitWithAbort(page.getTextContent(), context);
      const text = textContent.items
        .map(item => ('str' in item ? item.str : ''))
        .filter(Boolean)
        .join(' ')
        .trim();
      output.add(`## Page ${pageNumber}\n`);
      if (text) output.add(`${text}\n`);
      output.add('\n');
      page.cleanup();
    }
    return output.text();
  } finally {
    try {
      await Promise.resolve(loadingTask.destroy());
    } catch {
      // PDF.js cleanup must not replace an extraction result.
    }
  }
}

async function extractImage(
  input: ExtractDocumentInput,
  context: ParseContext,
): Promise<string> {
  const output = await describeImage({
    name: imageName(input.filename),
    mime: normalizedMime(input.mime),
    data: input.data,
    signal: context.signal,
  }, input.describeImage, context, false);
  if (new TextEncoder().encode(output).byteLength > MAX_OUTPUT_BYTES) {
    throw new ParseFailure('OUTPUT_TOO_LARGE');
  }
  return output;
}

export async function extractDocument(input: ExtractDocumentInput): Promise<ExtractDocumentResult> {
  const context = createParseContext(input?.signal);
  try {
    context.check();
    const kind = validateType(input);
    const data = new Uint8Array(input.data);
    let text: string;
    switch (kind) {
      case 'text':
        text = decodeUtf8(data);
        break;
      case 'pdf':
        text = await extractPdf(data, context);
        break;
      case 'docx':
      case 'pptx':
      case 'epub': {
        const archive = unzipArchive(data, context);
        text = kind === 'docx'
          ? await extractDocx(archive, context, input.describeImage)
          : kind === 'pptx'
            ? await extractPptx(archive, context, input.describeImage)
            : await extractEpub(archive, context, input.describeImage);
        break;
      }
      case 'image':
        text = await extractImage({ ...input, data }, context);
        break;
      default:
        throw new ParseFailure('UNSUPPORTED_TYPE');
    }
    if (new TextEncoder().encode(text).byteLength > MAX_OUTPUT_BYTES) {
      throw new ParseFailure('OUTPUT_TOO_LARGE');
    }
    return { ok: true, text };
  } catch (error) {
    const failure = failureCode(error, context);
    return { ok: false, error: { code: failure.code, message: failure.message } };
  } finally {
    context.close();
  }
}
