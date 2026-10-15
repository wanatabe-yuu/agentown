import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Render reports as data: no raw HTML, remote images, or embedded media. */
export function ReportText({ text }: { text: string }) {
  return <div className="report-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
    img: () => null,
    a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
    table: ({ children }) => <div className="report-table-scroll"><table>{children}</table></div>,
  }}>{text}</Markdown></div>;
}
