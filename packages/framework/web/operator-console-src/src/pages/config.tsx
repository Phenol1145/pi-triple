import { Card, EmptyState, PageHeader } from "../ui";

/** Config页占位：T3–T6 接入真实数据，当前不渲染任何模拟数据。 */
export default function ConfigPage() {
  return (
    <section class="page" data-page-root="config">
      <PageHeader title="Config" subtitle="配置视图" />
      <Card>
        <EmptyState title="页面将在 T3–T6 接入" description="当前为占位内容。" />
      </Card>
    </section>
  );
}
