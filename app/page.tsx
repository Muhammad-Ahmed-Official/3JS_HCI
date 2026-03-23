'use client';

import dynamic from 'next/dynamic';

const ParticleExperience = dynamic(
  () => import('./components/ParticleExperience'),
  {
    ssr: false,
    loading: () => (
      <div
        style={{
          display:        'flex',
          alignItems:     'center',
          justifyContent: 'center',
          width:          '100vw',
          height:         '100vh',
          background:     '#03030f',
          color:          '#4a5568',
          fontFamily:     'system-ui, sans-serif',
          fontSize:       14,
        }}
      >
        Loading…
      </div>
    ),
  }
);

export default function Home() {
  return <ParticleExperience />;
}
