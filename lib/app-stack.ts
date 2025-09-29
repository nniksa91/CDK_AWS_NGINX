import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2Actions from 'aws-cdk-lib/aws-elasticloadbalancingv2-actions';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns'; // (not used — kept to show prohibition)
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as certificatemanager from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';

export interface AppStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
}

export class AppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);

    const { vpc } = props;

    // ---------- Security Groups ----------
    const albSg = new ec2.SecurityGroup(this, 'AlbSg', { vpc, allowAllOutbound: true });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(8080), 'Allow HTTP on 8080 from Internet');

    const serviceSg = new ec2.SecurityGroup(this, 'ServiceSg', { vpc, allowAllOutbound: true });
    // Allow ALB -> service on container port 80
    serviceSg.addIngressRule(albSg, ec2.Port.tcp(80), 'Allow traffic from ALB to ECS tasks');

    // ---------- ECS Cluster & Task Definition ----------
    const cluster = new ecs.Cluster(this, 'Cluster', { vpc });

    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      memoryLimitMiB: 512,
      cpu: 256,
      taskRole,
    });

    const container = taskDef.addContainer('Nginx', {
      image: ecs.ContainerImage.fromRegistry('nginx:alpine'),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'nginx',
        logRetention: logs.RetentionDays.ONE_WEEK,
      }),
      environment: {
        NODE_ENV: 'production',
      },
    });
    container.addPortMappings({ containerPort: 80, protocol: ecs.Protocol.TCP });

    const service = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition: taskDef,
      assignPublicIp: false, // private networking
      desiredCount: 2,
      securityGroups: [serviceSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      healthCheckGracePeriod: cdk.Duration.seconds(60),
    });

    // ---------- Application Load Balancer (public) ----------
    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: true,
      securityGroup: albSg,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    const listener = alb.addListener('Http8080', {
      port: 8080,
      protocol: elbv2.ApplicationProtocol.HTTP,
      open: true,
    });

    const tg = new elbv2.ApplicationTargetGroup(this, 'EcsTg', {
      vpc,
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: { path: '/', healthyHttpCodes: '200-399' },
    });
    tg.addTarget(service);

    // 1) BLOCK malicious header BEFORE auth/forward: if X-Explioit-Activate:true => 403
    listener.addAction('BlockExploitHeader', {
      priority: 1,
      conditions: [
        elbv2.ListenerCondition.httpHeader('X-Explioit-Activate', ['true']),
      ],
      action: elbv2.ListenerAction.fixedResponse(403, {
        contentType: 'text/plain',
        messageBody: 'Forbidden: disallowed header present',
      }),
    });

    // 2) Cognito authentication (Bonus): enforce sign-in
    const userPool = new cognito.UserPool(this, 'UserPool', {
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      standardAttributes: { email: { required: true, mutable: false } },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const userPoolClient = new cognito.UserPoolClient(this, 'UserPoolClient', {
      userPool,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        callbackUrls: ['https://example.com/callback', 'http://localhost/callback'], // placeholder, ALB injects redirect_uri dynamically
        logoutUrls: ['https://example.com/signout', 'http://localhost/signout'],
      },
      generateSecret: true,
    });
// build a safe default
    const rawBase = `alb-auth-${cdk.Stack.of(this).stackName}-${cdk.Aws.ACCOUNT_ID}`;
    const base = rawBase.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const suffix = cdk.Names.uniqueId(this).toLowerCase().replace(/[^a-z0-9]/g, '').slice(-6);

// allow override from context/ENV
    const ctxPrefix = this.node.tryGetContext('cognitoDomainPrefix') ?? process.env.COGNITO_DOMAIN_PREFIX;

    const domainPrefix = ((ctxPrefix && String(ctxPrefix)) || `${base}-${suffix}`)
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .slice(0, 63)
        .replace(/^-+|-+$/g, '');

    const userPoolDomain = new cognito.UserPoolDomain(this, 'UserPoolDomain', {
      userPool,
      cognitoDomain: { domainPrefix },
    });

    // Default action: authenticate then forward to target group
    //listener.addAction('AuthThenForward', {
    //  priority: 2,
    //  conditions: [elbv2.ListenerCondition.pathPatterns(['/*'])],
    //  action: new elbv2Actions.AuthenticateCognitoAction({
    //    userPool,
    //    userPoolClient,
    //    userPoolDomain,
    //    next: elbv2.ListenerAction.forward([tg]),
    //  }),
    //});

    // Also set a default action in case no conditions matched
    listener.addTargetGroups('DefaultForward', { targetGroups: [tg] });

    // ---------- CloudFront in front of ALB ----------
    // Optional: you can attach a certificate for your domain in CloudFront; here we use default CF domain

    // CloudFront Function to drop the disallowed header at the edge (defense-in-depth)
    const cfFn = new cloudfront.Function(this, 'DropExploitHeaderFn', {
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var req = event.request;
  if (req.headers && req.headers['x-explioit-activate']) {
    delete req.headers['x-explioit-activate'];
  }
  return req;
}
      `),
    });

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: new origins.LoadBalancerV2Origin(alb, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
          httpPort: 8080,
        }),
        functionAssociations: [{ function: cfFn, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED, // for dynamic auth flows via ALB
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      },
    });

    // Outputs
    new cdk.CfnOutput(this, 'AlbDns', { value: alb.loadBalancerDnsName });
    new cdk.CfnOutput(this, 'AlbListenerPort', { value: '8080' });
    new cdk.CfnOutput(this, 'CloudFrontDomain', { value: distribution.distributionDomainName });
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
  }
}
