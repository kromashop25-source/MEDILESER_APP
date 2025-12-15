export default function HomePage() {
  return (
    <div className="vi-home">
      <div className="vi-home__brandbar">
        <img
          className="vi-home__brandlogo"
          src="/medileser/logo-vertical.jpg"
          alt="Medileser"
          draggable={false}
        />
      </div>

      <div
        className="vi-home__banner"
        style={{ backgroundImage: 'url("/medileser/banner.jpg")' }}
        role="img"
        aria-label="Medileser"
      />
    </div>
  );
}
