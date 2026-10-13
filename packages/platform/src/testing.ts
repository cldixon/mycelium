import { Miniflare } from "miniflare";

/**
 * Real D1 and R2 bindings backed by workerd, in memory, for tests. Call the
 * returned dispose() in afterEach/afterAll.
 */
export async function createTestBindings(): Promise<{
  db: D1Database;
  bucket: R2Bucket;
  dispose: () => Promise<void>;
}> {
  const mf = new Miniflare({
    modules: true,
    script: "export default {}",
    d1Databases: ["DB"],
    r2Buckets: ["DATA"],
  });
  const db = (await mf.getD1Database("DB")) as unknown as D1Database;
  const bucket = nativeBodies((await mf.getR2Bucket("DATA")) as unknown as R2Bucket);
  return { db, bucket, dispose: () => mf.dispose() };
}

/** Just a D1 database; see createTestBindings. */
export async function createTestD1(): Promise<{ db: D1Database; dispose: () => Promise<void> }> {
  const { db, dispose } = await createTestBindings();
  return { db, dispose };
}

/**
 * Miniflare hands back object bodies as proxied streams that Bun's Response
 * can't consume. Re-wrap each object fetched with get() so its body is a
 * native stream, as it is in the Workers runtime.
 */
function nativeBodies(bucket: R2Bucket): R2Bucket {
  return new Proxy(bucket, {
    get(target, prop, receiver) {
      if (prop !== "get") {
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (key: string, options?: R2GetOptions) => {
        const object = await (options ? target.get(key, options) : target.get(key));
        if (!object || !("arrayBuffer" in object)) return object;
        const bytes = await object.arrayBuffer();
        return {
          key: object.key,
          version: object.version,
          size: object.size,
          etag: object.etag,
          httpEtag: object.httpEtag,
          uploaded: object.uploaded,
          httpMetadata: object.httpMetadata,
          customMetadata: object.customMetadata,
          range: object.range,
          checksums: object.checksums,
          storageClass: object.storageClass,
          get body() {
            return new Blob([bytes]).stream();
          },
          bodyUsed: false,
          arrayBuffer: async () => bytes,
          text: async () => new TextDecoder().decode(bytes),
          json: async () => JSON.parse(new TextDecoder().decode(bytes)),
          blob: async () => new Blob([bytes]),
          writeHttpMetadata: (headers: Headers) => {
            const m = object.httpMetadata ?? {};
            if (m.contentType) headers.set("content-type", m.contentType);
          },
        } as unknown as R2ObjectBody;
      };
    },
  });
}
