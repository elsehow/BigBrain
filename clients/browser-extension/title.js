// The document's own title/heading wins. Raw text and source files often
// have neither: their URL filename is still a useful, faithful title.
(() => {
  globalThis.BigBrainTitle = {
    resolve({ title, heading, url }) {
      for (const value of [title, heading]) {
        const text = (value || "").replace(/\s+/g, " ").trim();
        if (text && !/^untitled(?: page)?$/i.test(text)) return text;
      }
      try {
        const parsed = new URL(url);
        const segment = parsed.pathname.split("/").filter(Boolean).at(-1);
        if (segment) {
          let name = segment;
          try { name = decodeURIComponent(segment); } catch { /* retain malformed escapes */ }
          return name.replace(/\s+/g, " ").trim() || parsed.hostname;
        }
        return parsed.hostname;
      } catch { return "Clipped page"; }
    },
  };
})();
