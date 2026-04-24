import Badge from "../ui/Badge";

function FeatureCard({
  title,
  description,
  badgeLabel,
  badgeTone = "default",
  className = "",
  children
}) {
  return (
    <article className={`feature-card ${className}`.trim()}>
      <header className="feature-card-head">
        <div>
          <h2>{title}</h2>
          {description ? <p className="feature-description">{description}</p> : null}
        </div>
        {badgeLabel ? <Badge tone={badgeTone}>{badgeLabel}</Badge> : null}
      </header>
      <div className="feature-card-body">{children}</div>
    </article>
  );
}

export default FeatureCard;
