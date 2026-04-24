function DashboardHeader({
  username,
  onLogout,
  onOpenProfile,
  onOpenLeaderboard,
  onOpenSocial
}) {
  return (
    <header className="dashboard-header">
      <div className="dashboard-heading">
        <div className="brand-mark">English Lemon</div>
        <h1>Welcome, {username}</h1>
        <p className="dashboard-subtitle">
          Train vocabulary, jump into quiz mode, and keep building English
          momentum every session.
        </p>
      </div>
      <div className="dashboard-header-actions">
        <button type="button" className="secondary-btn" onClick={onOpenLeaderboard}>
          Leaderboard
        </button>
        <button type="button" className="secondary-btn" onClick={onOpenSocial}>
          Social
        </button>
        <button type="button" className="secondary-btn" onClick={onOpenProfile}>
          Profile
        </button>
        <button type="button" className="secondary-btn" onClick={onLogout}>
          Logout
        </button>
      </div>
    </header>
  );
}

export default DashboardHeader;
