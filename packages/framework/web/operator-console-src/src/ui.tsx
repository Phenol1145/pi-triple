import type { ComponentChildren } from "preact";

export type ButtonVariant = "primary" | "ghost";

export interface ButtonProps {
  variant?: ButtonVariant;
  active?: boolean;
  onClick?: () => void;
  children: ComponentChildren;
}

export function Button(props: ButtonProps) {
  const { variant = "ghost", active = false, onClick, children } = props;
  const className = [
    "ui-button",
    `ui-button--${variant}`,
    active ? "is-active" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      type="button"
      class={className}
      aria-pressed={active ? true : undefined}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export type BadgeTone = "neutral" | "ok" | "warn" | "danger";

export interface BadgeProps {
  tone?: BadgeTone;
  children: ComponentChildren;
}

export function Badge(props: BadgeProps) {
  const { tone = "neutral", children } = props;
  return <span class={`ui-badge ui-badge--${tone}`}>{children}</span>;
}

export interface CardProps {
  title?: string;
  children: ComponentChildren;
}

export function Card(props: CardProps) {
  const { title, children } = props;
  return (
    <section class="ui-card">
      {title ? <h3 class="ui-card__title">{title}</h3> : null}
      <div class="ui-card__body">{children}</div>
    </section>
  );
}

export interface EmptyStateProps {
  title: string;
  description?: string;
  children?: ComponentChildren;
}

export function EmptyState(props: EmptyStateProps) {
  const { title, description, children } = props;
  return (
    <div class="ui-empty-state">
      <p class="ui-empty-state__title">{title}</p>
      {description ? (
        <p class="ui-empty-state__description">{description}</p>
      ) : null}
      {children}
    </div>
  );
}

export interface PageHeaderProps {
  title: string;
  subtitle?: string;
  children?: ComponentChildren;
}

export function PageHeader(props: PageHeaderProps) {
  const { title, subtitle, children } = props;
  return (
    <header class="ui-page-header">
      <div class="ui-page-header__text">
        <h2 class="ui-page-header__title">{title}</h2>
        {subtitle ? <p class="ui-page-header__subtitle">{subtitle}</p> : null}
      </div>
      {children ? <div class="ui-page-header__actions">{children}</div> : null}
    </header>
  );
}
