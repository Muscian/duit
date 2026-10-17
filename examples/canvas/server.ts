import { createServer } from "node:http";
// Intentionally exposes no DOM controls: only canvas pixels and a deterministic result.
const server = createServer((_req, res) => {
  res.setHeader("content-type", "text/html");
  res.end(`<!doctype html><title>DUIT canvas demo</title><style>body{margin:24px;font:20px system-ui}canvas{display:block}</style><h1>Canvas task</h1><canvas width="600" height="240"></canvas><p id="result">Waiting</p><script>
const canvas=document.querySelector('canvas'),c=canvas.getContext('2d');c.fillStyle='#1764cd';c.fillRect(40,50,240,90);c.font='28px sans-serif';c.fillStyle='white';c.fillText('Continue',95,105);canvas.addEventListener('click',e=>{const r=canvas.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top;if(x>=40&&x<=280&&y>=50&&y<=140)document.getElementById('result').textContent='Canvas confirmed';});
</script>`);
});
server.listen(Number(process.env.PORT ?? 4180), "127.0.0.1", () =>
  console.log("Canvas demo http://127.0.0.1:4180"),
);
