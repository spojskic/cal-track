// yauzl-promise ships no type declarations. Minimal surface used by the importer.
declare module 'yauzl-promise' {
  import type { Readable } from 'node:stream';

  export interface Entry {
    filename: string;
    uncompressedSize: number;
    compressedSize: number;
    openReadStream(options?: {
      decompress?: boolean;
      decrypt?: boolean;
      validateCrc32?: boolean;
    }): Promise<Readable>;
  }

  export interface Zip extends AsyncIterable<Entry> {
    readonly entryCount: number;
    readonly isOpen: boolean;
    readEntry(): Promise<Entry | null>;
    close(): Promise<void>;
  }

  export function open(path: string, options?: Record<string, unknown>): Promise<Zip>;
  export function fromBuffer(buffer: Buffer, options?: Record<string, unknown>): Promise<Zip>;

  const yauzl: {
    open: typeof open;
    fromBuffer: typeof fromBuffer;
  };
  export default yauzl;
}
