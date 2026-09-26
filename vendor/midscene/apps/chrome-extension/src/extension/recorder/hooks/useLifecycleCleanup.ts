import type { ChromeRecordedEvent } from '@midscene/recorder-ui';
import { message } from 'antd';
import { useEffect, useRef } from 'react';
import type { RecordingSession } from '../../../store';
import { recordLogger } from '../logger';

export const useLifecycleCleanup = (
  isRecording: boolean,
  stopRecording: () => Promise<void>,
  setIsRecording: (recording: boolean) => Promise<void>,
  currentSessionId: string | null,
  getCurrentSession: () => RecordingSession | null,
  updateSession: (
    sessionId: string,
    updates: Partial<RecordingSession>,
  ) => void,
  events: ChromeRecordedEvent[], // Add events parameter to save current events
  emergencySaveEvents: (events?: ChromeRecordedEvent[]) => Promise<void>, // Add emergency save function
) => {
  const latestRecording = useRef({
    isRecording, stopRecording, setIsRecording, currentSessionId,
    getCurrentSession, updateSession, events, emergencySaveEvents,
  });
  latestRecording.current = {
    isRecording, stopRecording, setIsRecording, currentSessionId,
    getCurrentSession, updateSession, events, emergencySaveEvents,
  };
  // Monitor visibility changes for the extension popup
  useEffect(() => {
    if (!isRecording) return;

    // Handle when user navigates away from extension popup
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden' && isRecording) {
        recordLogger.info('Extension popup hidden, stopping recording');
        stopRecording().then(() => {
          message.warning('Recording stopped - left extension popup');
        });
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Handle potential popup window close
    const handleBeforeUnload = () => {
      if (isRecording) {
        recordLogger.info(
          'Extension popup closing, stopping recording synchronously and saving events',
        );
        // For unload events, we need to stop synchronously and save immediately
        setIsRecording(false).catch(console.error);

        // Emergency save current events
        emergencySaveEvents(events).catch(console.error);

        if (currentSessionId) {
          const session = getCurrentSession();
          if (session) {
            // Save current events before closing
            updateSession(currentSessionId, {
              status: 'completed',
              events: [...events], // Save current recording events
              updatedAt: Date.now(),
            });
          }
        }
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [
    isRecording,
    stopRecording,
    setIsRecording,
    currentSessionId,
    getCurrentSession,
    updateSession,
  ]);

  // Cleanup on component unmount
  useEffect(() => {
    return () => {
      // Clean up any ongoing recording when component unmounts
      const latest = latestRecording.current;
      if (latest.isRecording) {
        recordLogger.info(
          'Component unmounting, cleaning up recording and saving events',
        );
        void (async () => {
          await latest.emergencySaveEvents(latest.events);
          await latest.stopRecording();
          await latest.setIsRecording(false);
        })().catch(console.error);

        if (latest.currentSessionId) {
          const session = latest.getCurrentSession();
          if (session) {
            // Save current events before unmounting
            latest.updateSession(latest.currentSessionId, {
              status: 'completed',
              events: [...latest.events],
              updatedAt: Date.now(),
            });
          }
        }
      }
    };
  }, []); // Empty dependency array means this runs only on unmount
};
