import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import './MediaMiniPlayer.css';

interface MediaInfo {
  title: string;
  artist: string;
  album_art: string | null;
  is_playing: boolean;
}

const ScrollableText: React.FC<{ text: string; className: string; title: string }> = ({ text, className, title }) => {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const textRef = React.useRef<HTMLDivElement>(null);
  const [shouldScroll, setShouldScroll] = React.useState(false);

  React.useEffect(() => {
    if (containerRef.current && textRef.current) {
      setShouldScroll(textRef.current.scrollWidth > containerRef.current.clientWidth);
    }
  }, [text]);

  return (
    <div ref={containerRef} className="scroll-container" title={title}>
      <div ref={textRef} className={`${className} scroll-text ${shouldScroll ? 'scrolling' : ''}`}>
        {text}
      </div>
      {/* Duplicate for seamless scrolling, only rendered if scrolling is needed */}
      {shouldScroll && (
        <div className={`${className} scroll-text scrolling`} aria-hidden="true">
          {text}
        </div>
      )}
    </div>
  );
};


export const MediaMiniPlayer: React.FC = () => {

  const [track, setTrack] = useState<MediaInfo | null>(null);

  useEffect(() => {
    let mounted = true;

    const fetchPlaying = async () => {
      try {
        const info = await invoke<MediaInfo | null>('get_media_info');
        if (mounted) setTrack(info);
      } catch (e) {
        console.error('get_media_info error', e);
      }
    };

    fetchPlaying();
    const interval = setInterval(fetchPlaying, 2000);

    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  const handlePlayPause = async () => {
    try {
      await invoke('media_play_pause');
      if (track) {
        setTrack(prev => prev ? { ...prev, is_playing: !prev.is_playing } : null);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleNext = async () => {
    try { await invoke('media_next'); } catch (e) { console.error(e); }
  };

  const handlePrevious = async () => {
    try { await invoke('media_previous'); } catch (e) { console.error(e); }
  };

  return (
    <div className="spotify-mini-player">
      {track && track.title ? (
        <div className="spotify-track-info">
          {track.album_art ? (
            <img src={track.album_art} alt="Album Art" className="spotify-album-art" />
          ) : (
            <div className="spotify-album-art" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '20px' }}>🎵</div>
          )}
          <div className="spotify-track-text">
            <ScrollableText className="spotify-track-name" title={track.title} text={track.title} />
            <ScrollableText className="spotify-artist-name" title={track.artist} text={track.artist} />
          </div>
        </div>
      ) : (
        <div className="spotify-idle-state">
          <div className="spotify-idle-text">Nothing playing</div>
        </div>
      )}
      <div className="spotify-controls">
        <button className="spotify-btn" onClick={handlePrevious} title="Previous">⏮</button>
        <button className="spotify-btn play-pause" onClick={handlePlayPause} title={track?.is_playing ? "Pause" : "Play"}>
          {track?.is_playing ? '⏸' : '▶'}
        </button>
        <button className="spotify-btn" onClick={handleNext} title="Next">⏭</button>
      </div>
    </div>
  );
};
