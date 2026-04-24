function Badge({ tone = "default", children }) {
  return <span className={`status-badge status-badge-${tone}`}>{children}</span>;
}

export default Badge;
