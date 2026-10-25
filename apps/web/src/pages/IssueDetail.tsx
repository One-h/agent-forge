import { useNavigate, useParams } from "react-router-dom";
import { IssueDetailDrawer } from "../components/IssueDetailDrawer";

export function IssueDetail() {
  const navigate = useNavigate();
  const { issueId: issueIdParam } = useParams();
  const issueId = Number(issueIdParam);

  return <IssueDetailDrawer issueId={issueId} onClose={() => navigate(-1)} onOpenJob={(jobId) => navigate(`/runs/${jobId}`)} />;
}
