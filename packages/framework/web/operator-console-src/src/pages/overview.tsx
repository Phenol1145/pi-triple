import { Card, EmptyState, PageHeader } from "../ui";

/** Overview页占位：T3–T6 接入真实数据，当前不渲染任何模拟数据。 */
export default function OverviewPage() {
  return (
    <section class="page" data-page-root="overview">
      <PageHeader title="Overview" subtitle="全局概览视图" />
      <Card>
        <EmptyState title="页面将在 T3–T6 接入" description="当前为占位内容。" />
      </Card>
    </section>
  );
}
