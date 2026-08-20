import { Card, EmptyState, PageHeader } from "../ui";

/** Work页占位：T3–T6 接入真实数据，当前不渲染任何模拟数据。 */
export default function WorkPage() {
  return (
    <section class="page" data-page-root="work">
      <PageHeader title="Work" subtitle="工作流视图" />
      <Card>
        <EmptyState title="页面将在 T3–T6 接入" description="当前为占位内容。" />
      </Card>
    </section>
  );
}
