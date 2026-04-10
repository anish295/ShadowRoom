/**
 * HeroGeometric — ShadowRoom Landing Hero
 *
 * Cinematic Vintage aesthetic:
 * - Radial vignette background
 * - Film grain overlay
 * - Glassmorphic shapes with depth-of-field blur
 * - Light leak lens flare
 * - Drifting ember particles
 *
 * Lazy-loaded via React.lazy() — framer-motion stays out of main bundle.
 */
import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { cn } from "../../lib/utils";

// ---------- Reduced-motion detection ----------
function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mql.matches);
    const handler = (e) => setReduced(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);
  return reduced;
}

// ---------- Drifting ember particles ----------
function FloatingParticles({ count = 30 }) {
  const particles = useMemo(() => {
    return Array.from({ length: count }, (_, i) => ({
      id: i,
      x: Math.random() * 100,
      y: Math.random() * 100,
      size: Math.random() * 3 + 1,
      delay: Math.random() * 8,
      duration: Math.random() * 6 + 6,
    }));
  }, [count]);

  return (
    <div className="geo-particles" aria-hidden="true">
      {particles.map((p) => (
        <span
          key={p.id}
          className="geo-particle"
          style={{
            left: `${p.x}%`,
            top: `${p.y}%`,
            width: `${p.size}px`,
            height: `${p.size}px`,
            animationDelay: `${p.delay}s`,
            animationDuration: `${p.duration}s`,
          }}
        />
      ))}
    </div>
  );
}

// ---------- Single glassmorphic shape ----------
function ElegantShape({
  className,
  delay = 0,
  width = 400,
  height = 100,
  rotate = 0,
  blurLevel = "geo-blur-mid",
  reducedMotion = false,
}) {
  return (
    <motion.div
      className={cn("geo-shape-wrap", className)}
      initial={reducedMotion ? false : { opacity: 0, y: -150, rotate: rotate - 15 }}
      animate={{ opacity: 1, y: 0, rotate }}
      transition={reducedMotion ? { duration: 0 } : {
        duration: 2.4,
        delay,
        ease: [0.23, 0.86, 0.39, 0.96],
      }}
    >
      <div
        className={cn("geo-shape-inner geo-glass", blurLevel)}
        style={{ width, height }}
      />
    </motion.div>
  );
}

// ---------- Animated text reveal ----------
function FadeText({ children, delay = 0, className, reducedMotion = false }) {
  return (
    <motion.span
      className={cn("geo-fade-text", className)}
      initial={reducedMotion ? false : { opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reducedMotion ? { duration: 0 } : { duration: 0.8, delay, ease: "easeOut" }}
    >
      {children}
    </motion.span>
  );
}

// ================================================================
//  MAIN COMPONENT
// ================================================================
export default function HeroGeometric({
  badge = "P2P & Encrypted",
  title1 = "The Future of",
  title2 = "Private Sharing.",
  onCreateRoom,
  onJoinRoom,
}) {
  const reducedMotion = usePrefersReducedMotion();

  return (
    <section className="geo-hero">
      {/* Background: vignette + grain + light leak */}
      <div className="geo-hero-bg" aria-hidden="true">
        <div className="geo-hero-gradient-top" />
        <div className="geo-hero-gradient-bottom" />
        <div className="geo-hero-grain" />
        <div className="geo-hero-light-leak" />
        <FloatingParticles count={24} />
      </div>

      {/* Glassmorphic shapes — varied depth via blur levels */}
      <div className="geo-shapes-container" aria-hidden="true">
        {/* Far — low blur, large, aggressive rotation */}
        <ElegantShape
          delay={0.3}
          width={650}
          height={160}
          rotate={25}
          blurLevel="geo-blur-far"
          className="geo-shape-1"
          reducedMotion={reducedMotion}
        />
        {/* Close — heavy blur, crisp edges */}
        <ElegantShape
          delay={0.5}
          width={500}
          height={130}
          rotate={-18}
          blurLevel="geo-blur-close"
          className="geo-shape-2"
          reducedMotion={reducedMotion}
        />
        {/* Mid — balanced */}
        <ElegantShape
          delay={0.4}
          width={320}
          height={90}
          rotate={-12}
          blurLevel="geo-blur-mid"
          className="geo-shape-3"
          reducedMotion={reducedMotion}
        />
        {/* Far — small, deep rotation */}
        <ElegantShape
          delay={0.6}
          width={220}
          height={65}
          rotate={30}
          blurLevel="geo-blur-far"
          className="geo-shape-4"
          reducedMotion={reducedMotion}
        />
        {/* Close — big anchor */}
        <ElegantShape
          delay={0.7}
          width={480}
          height={120}
          rotate={-25}
          blurLevel="geo-blur-close"
          className="geo-shape-5"
          reducedMotion={reducedMotion}
        />
      </div>

      {/* Content */}
      <div className="geo-content">
        {/* Badge */}
        <FadeText delay={0.6} reducedMotion={reducedMotion}>
          <span className="geo-badge">
            <i className="fas fa-shield-alt" />
            {badge}
          </span>
        </FadeText>

        {/* Title */}
        <h1 className="geo-title">
          <FadeText delay={0.8} className="geo-title-line" reducedMotion={reducedMotion}>
            {title1}
          </FadeText>
          <FadeText delay={1.0} className="geo-title-gradient-line" reducedMotion={reducedMotion}>
            {title2}
          </FadeText>
        </h1>

        {/* Subtitle */}
        <FadeText delay={1.2} reducedMotion={reducedMotion}>
          <p className="geo-subtitle">
            Anonymous, real-time chat rooms with P2P file sharing.
            <br />
            No sign-up. No tracking. No server storage.
          </p>
        </FadeText>

        {/* CTA Buttons */}
        <FadeText delay={1.4} reducedMotion={reducedMotion}>
          <div className="geo-actions">
            <button className="geo-btn geo-btn-primary" onClick={onCreateRoom}>
              <i className="fas fa-plus-circle" />
              Create Room
            </button>
            <button className="geo-btn geo-btn-secondary" onClick={onJoinRoom}>
              <i className="fas fa-sign-in-alt" />
              Join Room
            </button>
          </div>
        </FadeText>
      </div>
    </section>
  );
}
