import { useMemo, useState } from "react";
import { apiFetch } from "@/lib/apiFetch";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangle, Shield, Users, Database, Ban, Flag, ClipboardList, Activity, Plus, Trash2, BrainCircuit, Download } from "lucide-react";
import { useAppUser } from "@/contexts/UserContext";
import { LabConversation, LabMetric, LabPageHeader } from "@/components/lab/LivingLab";
const normalizeEmail = (value: string) => value.trim().toLowerCase();

async function fetchJson(path: string, init?: RequestInit) {
  const res = await apiFetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export function AdminPage() {
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const { email: signedInEmail, isLoaded } = useAppUser();
  const currentEmail = useMemo(
    () => normalizeEmail(signedInEmail),
    [signedInEmail],
  );

  const me = useQuery({
    queryKey: ["admin-me", currentEmail],
    enabled: isLoaded && !!currentEmail,
    queryFn: () => fetchJson("/api/admin/me", { headers: { "x-user-email": currentEmail } }),
  });
  const approvedEmail = me.data?.approved === true;
  const effectiveEmail = approvedEmail ? currentEmail : "";

  const stats = useQuery({
    queryKey: ["admin-stats", effectiveEmail],
    enabled: approvedEmail,
    queryFn: () => fetchJson("/api/admin/stats", { headers: { "x-user-email": effectiveEmail } }),
  });
  const training = useQuery({
    queryKey: ["ai-training-status", effectiveEmail],
    enabled: approvedEmail,
    queryFn: () => fetchJson("/api/ai/training/status", { headers: { "x-user-email": effectiveEmail } }),
  });

  const downloadTrainingData = async () => {
    const response = await apiFetch("/api/ai/training/export", { headers: { "x-user-email": effectiveEmail } });
    if (!response.ok) throw new Error("Training export failed");
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "biolab-ai-training.jsonl";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const suspend = useMutation({
    mutationFn: () => fetchJson("/api/admin/suspend", {
      method: "POST",
      headers: { "x-user-email": effectiveEmail },
      body: JSON.stringify({ email }),
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-stats"] }),
  });

  const addAdmin = useMutation({
    mutationFn: () => fetchJson("/api/admin/approved-admins", {
      method: "POST",
      headers: { "x-user-email": effectiveEmail },
      body: JSON.stringify({ email: adminEmail }),
    }),
    onSuccess: () => {
      setAdminEmail("");
      qc.invalidateQueries({ queryKey: ["admin-stats"] });
    },
  });

  const removeAdmin = useMutation({
    mutationFn: (targetEmail: string) => fetchJson(`/api/admin/approved-admins/${encodeURIComponent(targetEmail)}`, {
      method: "DELETE",
      headers: { "x-user-email": effectiveEmail },
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-stats"] }),
  });

  if (!isLoaded) return <Skeleton className="h-96 w-full" />;
  if (me.isLoading) return <Skeleton className="h-96 w-full" />;
  if (!approvedEmail) {
    return (
      <div className="lab-page space-y-7 pb-12" data-accent="rose">
        <LabPageHeader
          eyebrow="Protected governance boundary"
          title="This door is intentionally closed."
          description="Site-wide account controls are isolated from the scientific workspace and are only visible to explicitly approved administrators."
          icon={Shield}
          accent="rose"
          status="Authorization required"
        />
        <LabConversation label="Security boundary" accent="rose">
          Your current account is not on the approved administrator list. No governance data has been exposed.
        </LabConversation>
      </div>
    );
  }

  if (stats.isLoading) return <Skeleton className="h-96 w-full" />;

  if (stats.isError) {
    return (
      <Card className="border-destructive/30">
        <CardContent className="pt-6 flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-destructive mt-0.5" />
          <div>
            <p className="font-medium text-destructive">Admin access required</p>
            <p className="text-sm text-muted-foreground">This panel is only available to approved admins.</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const data = stats.data as any;
  const moderation = data.moderation_summary ?? { flagged_accounts: 0, pending_reviews: 0, high_priority_alerts: 0 };

  return (
    <div className="lab-page space-y-7 pb-12" data-accent="rose">
      <LabPageHeader
        eyebrow="Governance console"
        title="Protect the scientific workspace."
        description="Observe safe system-level counts, maintain the explicit administrator boundary, and take deliberate account actions from one controlled surface."
        icon={Shield}
        accent="rose"
        status="Authorized session"
      />

      <LabConversation label="Governance monitor" accent="rose">
        {moderation.high_priority_alerts
          ? `${moderation.high_priority_alerts} high-priority alert${moderation.high_priority_alerts === 1 ? " needs" : "s need"} review. Counts are intentionally summarized until a deliberate action is taken.`
          : "The governance surface is calm. No high-priority alerts are currently recorded, and sensitive details remain outside this summary view."}
      </LabConversation>

      <div className="grid gap-4 md:grid-cols-3">
        <LabMetric label="Experiments" value={data.total_experiments} detail="Total scientific records" icon={Users} accent="violet" index={0} />
        <LabMetric label="Administrators" value={data.approved_admins?.length ?? 0} detail="Explicitly approved" icon={Database} accent="cyan" index={1} />
        <LabMetric label="Recent records" value={data.recent_experiments?.length ?? 0} detail="Current activity window" icon={Activity} accent="emerald" index={2} />
        <LabMetric label="Flagged" value={moderation.flagged_accounts} detail="Accounts recorded" icon={Flag} accent="rose" index={3} />
        <LabMetric label="Pending" value={moderation.pending_reviews} detail="Reviews awaiting action" icon={ClipboardList} accent="amber" index={4} />
        <LabMetric label="Priority alerts" value={moderation.high_priority_alerts} detail="Requires attention" icon={Ban} accent="rose" index={5} />
      </div>

      <Card className="lab-panel rounded-[1.7rem]">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><BrainCircuit className="h-5 w-5 text-primary" /> Bio-Lab AI training set</CardTitle>
          <CardDescription>Only scientist-corrected, explicitly approved examples appear in the private JSONL export.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {training.isLoading ? <Skeleton className="h-20 w-full" /> : (
            <>
              <div className="flex flex-wrap gap-3 text-sm">
                <Badge variant="outline">{training.data?.approved_examples ?? 0} / 200 approved</Badge>
                <Badge variant={training.data?.ready_for_training ? "default" : "secondary"}>
                  {training.data?.ready_for_training ? "Ready for Colab" : "Collecting reviews"}
                </Badge>
                {(training.data?.missing_tasks ?? []).length > 0 && (
                  <span className="text-muted-foreground">Missing: {(training.data.missing_tasks as string[]).join(", ")}</span>
                )}
                {(training.data?.missing_splits ?? []).length > 0 && (
                  <span className="text-muted-foreground">Need project groups for: {(training.data.missing_splits as string[]).join(", ")}</span>
                )}
              </div>
              <Button variant="outline" className="gap-2" onClick={() => void downloadTrainingData()} disabled={!training.data?.approved_examples}>
                <Download className="h-4 w-4" /> Export de-identified JSONL
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      <Card className="lab-panel rounded-[1.7rem]">
        <CardHeader>
          <CardTitle>Approved Admins</CardTitle>
          <CardDescription>These email addresses are allowed into the admin panel.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-3">
            <Input value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} placeholder="admin@example.com" />
            <Button onClick={() => addAdmin.mutate()} disabled={!adminEmail || addAdmin.isPending}>
              <Plus className="mr-2 h-4 w-4" />
              Add admin
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            {data.approved_admins?.map((admin: { email: string }) => (
              <Badge key={admin.email} variant="outline" className="gap-2">
                {admin.email}
                <button
                  type="button"
                  className="ml-1 inline-flex items-center"
                  onClick={() => removeAdmin.mutate(admin.email)}
                  aria-label={`Remove ${admin.email}`}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </Badge>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card className="lab-panel rounded-[1.7rem]">
        <CardHeader>
          <CardTitle>Moderation Summary</CardTitle>
          <CardDescription>Safe summary counts only; no sensitive accusations or unverified claims.</CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          {moderation.flagged_accounts === 0 ? "No flagged accounts are currently recorded." : `${moderation.flagged_accounts} flagged accounts are recorded.`}
        </CardContent>
      </Card>

      <Card className="lab-panel rounded-[1.7rem] border-destructive/20">
        <CardHeader>
          <CardTitle>Suspend Account</CardTitle>
          <CardDescription>Enter an email to flag an account for suspension.</CardDescription>
        </CardHeader>
        <CardContent className="flex gap-3">
          <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="user@example.com" />
          <Button onClick={() => suspend.mutate()} disabled={!email || suspend.isPending}>Suspend</Button>
        </CardContent>
      </Card>
    </div>
  );
}
