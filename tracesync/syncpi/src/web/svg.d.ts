// SVG files are bundled as their markup (esbuild's text loader; see build.mjs).
declare module "*.svg" {
	const markup: string;
	export default markup;
}
