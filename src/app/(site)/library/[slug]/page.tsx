import { LibraryClient } from "../../../../components/library-client.tsx";
export default async function LibraryArticlePage({ params }: { params: Promise<{ slug: string }> }) { const { slug } = await params; return <LibraryClient slug={slug}/>; }
