// Wrangler bundles *.sql files as plain text via [[rules]] type = "Text"
declare module "*.sql" {
	const content: string;
	export default content;
}
