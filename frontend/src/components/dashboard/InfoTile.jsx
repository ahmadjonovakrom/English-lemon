function InfoTile({ label, children, className = "" }) {
  return (
    <section className={`info-tile ${className}`.trim()}>
      <p className="info-tile-label">{label}</p>
      <div className="info-tile-content">{children}</div>
    </section>
  );
}

export default InfoTile;
