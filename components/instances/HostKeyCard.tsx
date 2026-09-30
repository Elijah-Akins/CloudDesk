'use client';

import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { Button, Card, CardHeader, CardTitle, CardContent, ConfirmModal } from '@/components/ui';
import { instanceService } from '@/lib/services/instance.service';
import { toast } from '@/lib/stores';
import type { Instance } from '@/lib/types';

interface HostKeyCardProps {
  instance: Instance;
  onReset: () => void;
}

/**
 * Shows the SSH host key pinned for an instance and lets the owner forget it,
 * e.g. after rebuilding the server (connections are refused while it differs)
 */
export function HostKeyCard({ instance, onReset }: HostKeyCardProps) {
  const [showConfirm, setShowConfirm] = useState(false);
  const [isResetting, setIsResetting] = useState(false);

  const handleReset = async () => {
    setIsResetting(true);
    try {
      await instanceService.resetHostKey(instance.id);
      toast.success('Saved host key removed. The next connection will save the new one.');
      setShowConfirm(false);
      onReset();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to reset host key');
    } finally {
      setIsResetting(false);
    }
  };

  return (
    <Card padding="lg" className="mt-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="w-4 h-4" />
          SSH Host Key
        </CardTitle>
      </CardHeader>
      <CardContent>
        {instance.hostKeyFingerprint ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Connections are only allowed to a server presenting this key, which protects your
              credentials from interception. If you rebuilt or replaced the server, reset it.
            </p>
            <code className="block text-xs bg-muted px-3 py-2 rounded-md break-all">
              {instance.hostKeyFingerprint}
            </code>
            <Button variant="outline" size="sm" onClick={() => setShowConfirm(true)}>
              Reset saved host key
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No host key saved yet. The server&apos;s key is saved on the first successful connection,
            and later connections must match it.
          </p>
        )}
      </CardContent>

      <ConfirmModal
        isOpen={showConfirm}
        onClose={() => setShowConfirm(false)}
        onConfirm={handleReset}
        title="Reset SSH host key?"
        message="Only do this if you know the server's key changed (for example, it was rebuilt). The next connection will trust whatever key the server presents."
        confirmText="Reset host key"
        variant="warning"
        isLoading={isResetting}
      />
    </Card>
  );
}
