import FeatureCard from "./FeatureCard";

function ComingSoonCard({ title, description, milestones }) {
  return (
    <FeatureCard
      title={title}
      description={description}
      badgeLabel="Coming Soon"
      badgeTone="muted"
      className="roadmap-card"
    >
      <ul className="roadmap-list">
        {milestones.map((milestone) => (
          <li key={milestone}>{milestone}</li>
        ))}
      </ul>
    </FeatureCard>
  );
}

export default ComingSoonCard;
