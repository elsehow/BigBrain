// Picked up automatically by `web-ext build` and `web-ext lint` when run with
// this directory as the source dir.
//
// preview.html is the popup's dev harness (see README): it belongs in git,
// because it is how you look at the popup without installing anything, and it
// does not belong in a store package.
//
// NOT `_preview.html`. Chrome reserves the `_` prefix for the system and
// refuses to load an unpacked extension that contains one — "Could not load
// manifest", naming a file the manifest never mentions. The underscore is the
// obvious way to mark a file as not-shipped, and it is the one prefix that
// breaks the entire extension. This ignore list is how a file opts out here.
module.exports = {
  ignoreFiles: ["preview.html"],
};
