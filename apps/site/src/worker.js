// Serves the static site. Videos need HTTP Range (Safari and iOS refuse to play an MP4 without 206 responses),
// which static assets don't answer, so /media/*.mp4 is sliced here.
export default {
  async fetch(request, env) {
    const range = request.headers.get("Range");
    const url = new URL(request.url);
    if (!range || !url.pathname.endsWith(".mp4")) return env.ASSETS.fetch(request);
    const res = await env.ASSETS.fetch(new Request(url, { method: "GET" }));
    if (res.status !== 200) return res;
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    const body = await res.arrayBuffer();
    const size = body.byteLength;
    if (!m) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    let start = m[1] === "" ? size - Number(m[2]) : Number(m[1]);
    let end = m[1] === "" || m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
    if (start < 0) start = 0;
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    const headers = new Headers(res.headers);
    headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
    headers.set("Content-Length", String(end - start + 1));
    headers.set("Accept-Ranges", "bytes");
    return new Response(request.method === "HEAD" ? null : body.slice(start, end + 1), { status: 206, headers });
  },
};
