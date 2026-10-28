// The page used to load Tailwind from its CDN; this app's content security policy only allows its own scripts and
// styles, so the classes are compiled into public/inspections.css at build time instead.
module.exports = {
  content: ['../../public/inspections.html', './*.tsx', './*.ts'],
  future: { hoverOnlyWhenSupported: true },
};
