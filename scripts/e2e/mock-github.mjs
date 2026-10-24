// A stand-in for api.github.com used by the end-to-end tests: it reports one "latest release",
// whose tag is read from a state file on every request so a test can publish a new one.
//   node mock-github.mjs <port> <state.json>      state.json: {"tag":"v1.0.1"}
import http from 'node:http';
import fs from 'node:fs';

const [port, stateFile] = [Number(process.argv[2]), process.argv[3]];
http
  .createServer((req, res) => {
    let tag;
    try {
      tag = JSON.parse(fs.readFileSync(stateFile, 'utf8')).tag;
    } catch {
      res.writeHead(503); // the test is rewriting the state file right now
      return res.end('{}');
    }
    if (/^\/repos\/[^/]+\/[^/]+\/releases\/latest$/.test(req.url)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          tag_name: tag,
          name: `HomeVault ${tag}`,
          body: `Release notes for ${tag}\n\n- Something new\n- Something fixed`,
          html_url: `https://github.com/test/homevault/releases/tag/${tag}`,
          published_at: '2026-10-24T12:00:00Z',
          draft: false,
          prerelease: false,
        })
      );
    } else {
      res.writeHead(404);
      res.end('{}');
    }
  })
  .listen(port, '0.0.0.0', () => console.log(`mock github listening on ${port}`));
