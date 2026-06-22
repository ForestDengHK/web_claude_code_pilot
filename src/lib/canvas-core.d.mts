// Type declarations for the shared canvas core (canvas-core.mjs).
export type Engine = 'excalidraw' | 'drawio' | 'mermaid';
export interface CanvasElement { id: string; type?: string; text?: string; x?: number; y?: number; width?: number; height?: number; [k: string]: unknown; }
export interface CanvasOps { add?: CanvasElement[]; update?: ({ id: string } & Record<string, unknown>)[]; delete?: string[]; }
export interface DiagramMeta { id: string; engine: Engine; title: string; version: number; lastAuthor?: string; sessionId?: string; updatedAt: string; }
export interface ListEntry { id: string; title: string; engine: Engine; version: number; elementCount: number; sessionId: string; updatedAt: string; }

export const ENGINE_EXT: Record<string, string>;
export function engineToExt(engine: string): string;
export function applyOps(elements: CanvasElement[], ops: CanvasOps): { elements: CanvasElement[]; applied: { added: number; updated: number; deleted: number }; warnings: string[] };
export function safeId(id: string): string;
export function genId(): string;
export function readMeta(dir: string, id: string): DiagramMeta;
export function readElements(dir: string, id: string, engine: string): CanvasElement[];
export function readRawData(dir: string, id: string, engine: string): string;
export function createDiagram(dir: string, args: { id?: string; engine: Engine; title?: string; scene: unknown; author?: string; sessionId?: string }): { id: string; version: number };
export function writeScene(dir: string, id: string, elements: CanvasElement[], author?: string): { id: string; version: number; count: number };
export function writeSource(dir: string, id: string, source: string, author?: string): { id: string; version: number };
export function coerceElements(scene: unknown): CanvasElement[];
export function readDiagram(dir: string, id: string): { id: string; engine: Engine; version: number; elements?: CanvasElement[]; source?: string };
export function updateDiagram(dir: string, id: string, ops: CanvasOps, author?: string): { id: string; version: number; applied: { added: number; updated: number; deleted: number }; warnings: string[] };
export function listDiagrams(dir: string, sessionId?: string): ListEntry[];
