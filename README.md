# CDK: ECS Fargate (nginx) behind public ALB on :8080 and CloudFront (no ecs_patterns)


**Requirements met**
- Two stacks: `NetworkDiscoveryStack` performs VPC *search/lookup* (or creates one). `EcsNginxWithCfStack` contains ECS/Fargate, ALB, listener on **8080**, CloudFront, and optional Cognito.
- Service runs in **private subnets** (no public IP). ALB is **public**. Listener maps external TCP **8080** → container **80**.
- **No `aws_ecs_patterns`** constructs are used for the service/ALB wiring.
- **CloudFront** sits in front of ALB.
- Request containing header `X-Explioit-Activate: true` is **blocked** at ALB (403) and also **stripped at CloudFront** via a CF Function.
- **Bonus:** Cognito auth enforced at ALB via `authenticateCognito` action.


## Deploy
```bash
npm i
npm run build
# Use an existing VPC (default) or create one
cdk deploy NetworkDiscoveryStack -c useDefaultVpc=true
cdk deploy EcsNginxWithCfStack -c cognitoDomainPrefix="cognitoDomainPrefix"
```


To lookup by name instead:
```bash
cdk deploy NetworkDiscoveryStack -c vpcName=my-vpc
cdk deploy EcsNginxWithCfStack -c cognitoDomainPrefix="cognitoDomainPrefix"
```


## Test
- Get ALB DNS from output `AlbDns` and hit: `http://<ALB_DNS>:8080/` (will redirect to Cognito sign-in).
- Or use CloudFront domain from `CloudFrontDomain`.
- Verify header block: `curl -H 'X-Explioit-Activate: true' http://<ALB_DNS>:8080/ -i` should return **403**.


## Notes
- Replace CloudFront domains in user-pool client callback/logout URLs with your real domain once set (ALB/CNAME/CF). For production, attach your ACM cert in CloudFront and set custom domains.
- For a pure block instead of strip at edge, remove the CF Function and rely solely on the ALB rule.
- Scale Fargate by `desiredCount` or add autoscaling on CPU/Memory as needed.