import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
export async function startShop(port = 4173) {
  const html = await readFile(
    fileURLToPath(new URL("./index.html", import.meta.url)),
  );
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise<void>((resolve) =>
    server.listen(port, "127.0.0.1", resolve),
  );
  const address = server.address();
  return {
    server,
    url: `http://127.0.0.1:${typeof address === "object" && address ? address.port : port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      ),
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const shop = await startShop();
  console.log(`Demo shop: ${shop.url}`);
}
