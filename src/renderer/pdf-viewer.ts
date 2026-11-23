import * as pdfjsLib from "pdfjs-dist";

// Load bundled local PDF.js worker; disable eval and XFA/scripting for document safety
pdfjsLib.GlobalWorkerOptions.workerSrc = "./pdf.worker.min.mjs";

export interface PdfRenderState {
  currentPage: number;
  totalPages: number;
  zoom: number;
}

export class PdfPreviewController {
  private loadingTask: pdfjsLib.PDFDocumentLoadingTask | null = null;
  private doc: pdfjsLib.PDFDocumentProxy | null = null;
  private currentPage = 1;
  private zoom = 1.0;
  private readonly canvas: HTMLCanvasElement;
  private activeRenderTask: pdfjsLib.RenderTask | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  async loadBytes(bytes: Uint8Array): Promise<PdfRenderState> {
    await this.destroy();
    const loadingTask = pdfjsLib.getDocument({
      data: bytes,
      enableXfa: false,
      useSystemFonts: true,
    });
    this.loadingTask = loadingTask;
    this.doc = await loadingTask.promise;
    this.currentPage = 1;
    this.zoom = 1.0;
    await this.renderCurrentPage();
    return this.getState();
  }

  getState(): PdfRenderState {
    return {
      currentPage: this.currentPage,
      totalPages: this.doc?.numPages ?? 0,
      zoom: this.zoom,
    };
  }

  async goToPage(pageNumber: number): Promise<PdfRenderState> {
    if (!this.doc) return this.getState();
    const clamped = Math.max(1, Math.min(this.doc.numPages, pageNumber));
    this.currentPage = clamped;
    await this.renderCurrentPage();
    return this.getState();
  }

  async setZoom(nextZoom: number): Promise<PdfRenderState> {
    if (!this.doc) return this.getState();
    const clamped = Math.max(0.5, Math.min(3.0, Math.round(nextZoom * 100) / 100));
    this.zoom = clamped;
    await this.renderCurrentPage();
    return this.getState();
  }

  private async renderCurrentPage(): Promise<void> {
    if (!this.doc) return;
    if (this.activeRenderTask) {
      try {
        this.activeRenderTask.cancel();
      } catch {
        // ignore cancel error
      }
      this.activeRenderTask = null;
    }

    const page = await this.doc.getPage(this.currentPage);
    const viewport = page.getViewport({ scale: this.zoom });
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;

    this.canvas.width = Math.ceil(viewport.width);
    this.canvas.height = Math.ceil(viewport.height);
    this.canvas.style.width = `${Math.ceil(viewport.width)}px`;
    this.canvas.style.height = `${Math.ceil(viewport.height)}px`;

    const task = page.render({
      canvasContext: ctx,
      viewport,
      canvas: this.canvas,
    });
    this.activeRenderTask = task;
    try {
      await task.promise;
    } finally {
      if (this.activeRenderTask === task) {
        this.activeRenderTask = null;
      }
    }
  }

  async destroy(): Promise<void> {
    if (this.activeRenderTask) {
      try {
        this.activeRenderTask.cancel();
      } catch {
        // ignore
      }
      this.activeRenderTask = null;
    }
    if (this.doc) {
      await this.doc.cleanup();
      this.doc = null;
    }
    if (this.loadingTask) {
      await this.loadingTask.destroy();
      this.loadingTask = null;
    }
  }
}
