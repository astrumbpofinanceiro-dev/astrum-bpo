export interface FileStorage {
  readonly bucket: string;
  /** Nunca sobrescreve: o original é preservado. */
  put(key: string, bytes: Buffer, mimeType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  signedUrl(key: string, downloadName: string): Promise<string>;
  /** Somente para desfazer um envio cujo registro não foi gravado. */
  remove(key: string): Promise<void>;
}
