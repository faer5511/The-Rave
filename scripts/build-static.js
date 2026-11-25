import { cp, mkdir, rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await mkdir("dist/static/css", { recursive: true });
await mkdir("dist/static/js", { recursive: true });

await cp("static/index.html", "dist/index.html");
await cp("static/admin.html", "dist/admin.html");
await cp("static/admin-login.html", "dist/admin-login.html");
await cp("static/css", "dist/static/css", { recursive: true });
await cp("static/js", "dist/static/js", { recursive: true });

console.log("Static assets built in dist/");
